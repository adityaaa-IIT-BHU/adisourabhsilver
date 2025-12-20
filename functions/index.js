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
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const VERIFY_TOKEN = "silver_seva_secret"; 

exports.webhook = functions.https.onRequest(async (req, res) => {
    if (req.method === "GET") {
        if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
            res.status(200).send(req.query["hub.challenge"]);
        } else {
            res.sendStatus(403);
        }
    } 
    else if (req.method === "POST") {
        try {
            const body = req.body;
            if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                
                const messageObj = body.entry[0].changes[0].value.messages[0];
                const from = messageObj.from; 
                const msgType = messageObj.type;
                const msgBody = msgType === "text" ? messageObj.text.body : "";

                // --- 1. IDENTIFY USER TYPE (NURSE OR CLIENT) ---
                // We search across all users' nurse collections. 
                // Note: In a real app, you might want a root-level 'nurses' collection for faster lookup.
                // For now, we assume you put nurses in a root collection named 'nurses' based on your index.html usage.
                
                // Let's assume you moved to a root 'nurses' collection for easier lookup:
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

                        await sendWhatsApp(from, `✅ Status: AVAILABLE\n📍 Location updated. You will receive booking alerts near you.`);
                    } 
                    else if (msgBody.toLowerCase().includes("stop")) {
                        // NURSE GOES OFFLINE
                        await db.collection('nurses').doc(nurseDoc.id).update({ status: "offline" });
                        await sendWhatsApp(from, `🔴 Status: OFFLINE. Have a good rest!`);
                    }
                    else {
                        await sendWhatsApp(from, `👋 Namaste ${nurseData.name}.\n\nShare your *Location* attachment to go ONLINE.\nReply STOP to go OFFLINE.`);
                    }
                } 
                else {
                    // --- CLIENT LOGIC (EXISTING AI) ---
                    
                    // 1. Fetch History
                    const convoRef = db.collection('conversations').doc(from);
                    const convoDoc = await convoRef.get();
                    let history = convoDoc.exists ? convoDoc.data().history : [];

                    // 2. Add New User Message
                    history.push({ role: "user", content: msgBody });
                    if (history.length > 10) history = history.slice(-10);

                    // 3. Ask AI
                    const aiDecision = await chatWithAI(history);

                    if (aiDecision.isBooking) {
                        // 4. FIND NEAREST NURSE
                        // Note: If client provided text location, AI gives us text. 
                        // If client sent a Pin, we'd have lat/lng. 
                        // For this example, we assume AI gives text, but we try to find ANY available nurse.
                        
                        const assignedNurse = await findNearestAvailableNurse();

                        if (assignedNurse) {
                            // CREATE BOOKING
                            await db.collection('bookings').add({
                                clientPhone: from,
                                ...aiDecision.data,
                                assignedNurseId: assignedNurse.id,
                                assignedNurseName: assignedNurse.name,
                                status: 'assigned',
                                timestamp: Date.now()
                            });

                            // UPDATE NURSE STATUS
                            await db.collection('nurses').doc(assignedNurse.id).update({ status: 'busy' });

                            // NOTIFY CLIENT
                            await sendWhatsApp(from, `✅ Booking Confirmed!\n\n👩‍⚕️ Nurse Assigned: ${assignedNurse.name}\n📍 Loc: ${aiDecision.data.location}\n⏰ Time: ${aiDecision.data.time}`);

                            // NOTIFY NURSE
                            await sendWhatsApp(assignedNurse.phone, `🚑 NEW DUTY ASSIGNED!\n\n📍 Go To: ${aiDecision.data.location}\n⏰ Time: ${aiDecision.data.time}\n👤 Patient: ${aiDecision.data.patient_details}\n\nReply with a photo when you reach.`);

                        } else {
                            // NO NURSE AVAILABLE
                            await db.collection('bookings').add({
                                clientPhone: from,
                                ...aiDecision.data,
                                status: 'pending_no_nurse',
                                timestamp: Date.now()
                            });

                            await sendWhatsApp(from, `✅ Booking Received.\n\n⚠️ All nurses are currently busy. We will assign one shortly and notify you.`);
                        }

                        // Clear history
                        await convoRef.delete(); 

                    } else {
                        // AI asks follow-up
                        await sendWhatsApp(from, aiDecision.message);
                        history.push({ role: "assistant", content: aiDecision.message });
                        await convoRef.set({ history: history });
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

// --- HELPER: FIND NURSE ---
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
        if (nurse.currentLocation) {
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

// --- MATH: HAVERSINE FORMULA (Distance in KM) ---
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // Radius of the earth in km
    var dLat = deg2rad(lat2-lat1);  // deg2rad below
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

// --- EXISTING AI FUNCTION (Unchanged) ---
async function chatWithAI(history) {
    // ... (Keep your existing chatWithAI code exactly as it is) ...
    // JUST COPY PASTE YOUR EXISTING chatWithAI FUNCTION HERE
    try {
        const systemMessage = { 
            role: "system", 
            content: `You are the receptionist for 'Silver Seva'.
            GOAL: Collect 3 things: Location, Time, Patient Details.
            RULES: Be polite and Indian-style (Namaste). Only ask for missing info.`
        };

        const response = await openai.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [systemMessage, ...history], 
            functions: [{
                name: "create_booking",
                description: "Finalize booking",
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

// --- EXISTING SEND WHATSAPP (Unchanged) ---
async function sendWhatsApp(to, text) {
    // ... (Keep your existing sendWhatsApp code exactly as it is) ...
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
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