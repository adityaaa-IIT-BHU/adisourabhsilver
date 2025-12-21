/**
 * functions/index.js
 * NOW WITH MEMORY: Saves chat history to Firestore so AI remembers details.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURATION ---
const openai = new OpenAI({ 
    apiKey: "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", 
    baseURL: "https://api.groq.com/openai/v1" 
});

// PASTE YOUR META TOKEN HERE
const WHATSAPP_TOKEN = "EAAMqTZAWNCSUBQTHwiPYAF07ytkuB8M595NGyOgqIH2glXm0ZCZAVYtHNjZAqhxyXSaHD8YHKAEw195teIsLAA9ymxwxQnvs4dcnnUD7E8OzxOkbU62WT0TnwOSWRrC2IlUhFjpUVVWOO4KWLGAr5bgVeidZC7J92P7omzgG0pAItZBavwPyP9KdHtFpo3uwZDZD"; 
const PHONE_NUMBER_ID = "912741208590042"; 
const VERIFY_TOKEN = "silver_seva_secret"; 

exports.webhook = functions.https.onRequest(async (req, res) => {
    // 1. VERIFY TOKEN
    if (req.method === "GET") {
        if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
            res.status(200).send(req.query["hub.challenge"]);
        } else {
            res.sendStatus(403);
        }
    } 
    // 2. HANDLE MESSAGES
    else if (req.method === "POST") {
        try {
            const body = req.body;
            if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                
                const messageObj = body.entry[0].changes[0].value.messages[0];
                const from = messageObj.from; 
                const msgType = messageObj.type;
                const msgBody = msgType === "text" ? messageObj.text.body : "";

                // --- 1. IDENTIFY USER TYPE (NURSE OR CLIENT) ---
                // We check the root 'nurses' collection to see if the sender is staff
                const nurseQuery = await db.collection('nurses').where('phone', '==', from).get();
                const isNurse = !nurseQuery.empty;

                if (isNurse) {
                    const nurseDoc = nurseQuery.docs[0];
                    const nurseData = nurseDoc.data();

                    // --- NURSE LOGIC ---
                    if (msgType === "location") {
                        // NURSE SHARED LOCATION -> MARK AVAILABLE
                        const loc = messageObj.location;
                        
                        await db.collection('nurses').doc(nurseDoc.id).update({
                            status: "available",
                            currentLocation: {
                                lat: loc.latitude,
                                lng: loc.longitude,
                                address: loc.address || "Live Location"
                            },
                            lastActive: Date.now()
                        });

                        await sendWhatsApp(from, ✅ Status: AVAILABLE\n📍 Location updated. You will receive booking alerts near you.);
                    } 
                    else if (msgBody.toLowerCase().includes("stop")) {
                        // NURSE GOES OFFLINE
                        await db.collection('nurses').doc(nurseDoc.id).update({ status: "offline" });
                        await sendWhatsApp(from, 🔴 Status: OFFLINE. Have a good rest!);
                    }
                    else {
                        await sendWhatsApp(from, 👋 Namaste ${nurseData.name}.\n\nShare your *Location* attachment to go ONLINE.\nReply STOP to go OFFLINE.);
                    }
                } 
                else {
                    // --- 2. CLIENT LOGIC (UPDATED WITH LOCATION) ---
                    
                    // Fetch History & Coords
                    const convoRef = db.collection('conversations').doc(from);
                    const convoDoc = await convoRef.get();
                    let history = convoDoc.exists ? convoDoc.data().history : [];
                    let clientCoords = convoDoc.exists ? convoDoc.data().coords : null;

                    // HANDLE CLIENT INPUT
                    if (msgType === "location") {
                        // A. User sent a location pin
                        clientCoords = {
                            lat: messageObj.location.latitude,
                            lng: messageObj.location.longitude
                        };
                        
                        // Trick AI into knowing the user provided location
                        history.push({ role: "user", content: "I have sent my location pin attachment." });
                        
                        // Save coords to DB so we don't lose them
                        await convoRef.set({ history, coords: clientCoords }, { merge: true });
                    } 
                    else if (msgType === "text") {
                        // B. User sent text
                        history.push({ role: "user", content: msgBody });
                    }

                    // Keep History Short
                    if (history.length > 10) history = history.slice(-10);

                    // Ask AI
                    const aiDecision = await chatWithAI(history);

                    if (aiDecision.isBooking) {
                        // --- 3. FIND NEAREST NURSE ---
                        // Pass client coords (if any) to the finder function
                        const assignedNurse = await findNearestAvailableNurse(
                            clientCoords ? clientCoords.lat : null,
                            clientCoords ? clientCoords.lng : null
                        );

                        if (assignedNurse) {
                            // CREATE BOOKING
                            await db.collection('bookings').add({
                                clientPhone: from,
                                ...aiDecision.data,
                                clientLocation: clientCoords || null, // Save client lat/lng
                                assignedNurseId: assignedNurse.id,
                                assignedNurseName: assignedNurse.name,
                                status: 'assigned',
                                timestamp: Date.now()
                            });

                            // UPDATE NURSE STATUS
                            await db.collection('nurses').doc(assignedNurse.id).update({ status: 'busy' });

                            // NOTIFY CLIENT
                            await sendWhatsApp(from, ✅ Booking Confirmed!\n\n👩‍⚕️ Nurse Assigned: ${assignedNurse.name}\n📍 Loc: ${aiDecision.data.location}\n⏰ Time: ${aiDecision.data.time});

                            // NOTIFY NURSE (Text)
                            await sendWhatsApp(assignedNurse.phone, 🚑 NEW DUTY ASSIGNED!\n\n👤 Patient: ${aiDecision.data.patient_details}\n⏰ Time: ${aiDecision.data.time});
                            
                            // NOTIFY NURSE (Map Bubble)
                            if (clientCoords) {
                                await sendWhatsAppLocation(
                                    assignedNurse.phone, 
                                    clientCoords.lat, 
                                    clientCoords.lng, 
                                    "Patient Location", 
                                    aiDecision.data.location
                                );
                            } else {
                                await sendWhatsApp(assignedNurse.phone, 📍 Address: ${aiDecision.data.location} (No Map Pin provided));
                            }

                        } else {
                            // NO NURSE AVAILABLE
                            await db.collection('bookings').add({
                                clientPhone: from,
                                ...aiDecision.data,
                                status: 'pending_no_nurse',
                                timestamp: Date.now()
                            });

                            await sendWhatsApp(from, ✅ Booking Received.\n\n⚠️ All nurses are currently busy. We will assign one shortly and notify you.);
                        }

                        // Clear history after booking
                        await convoRef.delete(); 

                    } else {
                        // AI asks follow-up
                        await sendWhatsApp(from, aiDecision.message);
                        history.push({ role: "assistant", content: aiDecision.message });
                        await convoRef.set({ history, coords: clientCoords || null });
                    }
                }
            }
            res.sendStatus(200);
        } catch (e) {
            console.error("Error:", e);
            res.sendStatus(500);
        }
    }
});

// --- HELPER: FIND NEAREST AVAILABLE NURSE ---
async function findNearestAvailableNurse(clientLat = null, clientLng = null) {
    const nursesRef = db.collection('nurses');
    // Get all nurses who are 'available'
    const snapshot = await nursesRef.where('status', '==', 'available').get();
    
    if (snapshot.empty) return null;

    let nurses = [];
    snapshot.forEach(doc => nurses.push({ id: doc.id, ...doc.data() }));

    // If we don't have client coordinates (Text based booking), return the first available one
    if (!clientLat || !clientLng) {
        return nurses[0]; 
    }

    // If we DO have client coordinates, use Haversine formula to find nearest
    let nearestNurse = null;
    let minDistance = Infinity;

    nurses.forEach(nurse => {
        if (nurse.currentLocation && nurse.currentLocation.lat) {
            const dist = getDistanceFromLatLonInKm(
                clientLat, clientLng, 
                nurse.currentLocation.lat, nurse.currentLocation.lng
            );
            if (dist < minDistance) {
                minDistance = dist;
                nearestNurse = nurse;
            }
        }
    });

    // If calculation fails but we have nurses, just return the first one
    return nearestNurse || nurses[0];
}

// --- HELPER: SEND LOCATION BUBBLE (MAP) ---
async function sendWhatsAppLocation(to, lat, lng, name, address) {
    try {
        await axios({
            method: "POST",
            url: https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages,
            headers: {
                "Authorization": Bearer ${WHATSAPP_TOKEN},
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to: to,
                type: "location",
                location: {
                    longitude: lng,
                    latitude: lat,
                    name: name,
                    address: address
                }
            },
        });
    } catch (e) {
        console.error("Location Send Error:", e.response ? e.response.data : e);
    }
}

// --- MATH: HAVERSINE FORMULA (Distance in KM) ---
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // Radius of the earth in km
    var dLat = deg2rad(lat2-lat1);
    var dLon = deg2rad(lon2-lon1); 
    var a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat1)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    var d = R * c; // Distance in km
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI/180)
}

// --- SMART AI BRAIN (Unchanged Logic) ---
async function chatWithAI(history) {
    try {
        const systemMessage = { 
            role: "system", 
            content: `You are the receptionist for 'Silver Seva'.
            GOAL: Collect 3 things: Location, Time, Patient Details.
            
            MEMORY RULES:
            - Read the entire conversation history provided.
            - If the user ALREADY said the location (or sent a pin), DO NOT ask for it again.
            - Only ask for what is MISSING.
            - If you have Location, Time, and Patient Details, call 'create_booking'.
            - Be polite and Indian-style (Namaste).`
        };

        const response = await openai.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [systemMessage, ...history], 
            functions: [{
                name: "create_booking",
                description: "Finalize booking when Location, Time, and Patient Details are ALL known",
                parameters: {
                    type: "object",
                    properties: {
                        location: { type: "string" },
                        time: { type: "string" },
                        patient_details: { type: "string" }
                    },
                    required: ["location", "time", "patient_details"]
                }
            }],
            function_call: "auto" 
        });

        const msg = response.choices[0].message;

        if (msg.function_call) {
            return { isBooking: true, data: JSON.parse(msg.function_call.arguments) };
        } else {
            return { isBooking: false, message: msg.content };
        }

    } catch (e) {
        console.error("AI Error:", e);
        return { isBooking: false, message: "Network error. Please try again." };
    }
}

// --- SEND TEXT HELPER ---
async function sendWhatsApp(to, text) {
    try {
        await axios({
            method: "POST",
            url: https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages,
            headers: {
                "Authorization": Bearer ${WHATSAPP_TOKEN},
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: text },
            },
        });
    } catch (e) {
        console.error("Send Error:", e.response ? e.response.data : e);
    }
}
