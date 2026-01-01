/**
 * functions/index.js
 * NOW WITH MEMORY: Saves chat history to Firestore so AI remembers details.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const axios = require("axios");

const fs = require("fs");
const os = require("os");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURATION ---
const openai = new OpenAI({ 
    apiKey: "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" // <--- PASTE YOUR FULL NEW KEY HERE inside the quotes
});
// [ADD THIS] Initialize Storage for Audio Files
const storage = admin.storage();
const bucket = storage.bucket(); 

// [ADD THIS] EXOTEL CREDENTIALS (From your Dashboard)
const EXOTEL_API_KEY = "b84cd31104a620b59d73d2b0546dc33e98eed6b149ba9146"; 
const EXOTEL_TOKEN = "947c821cb8f1276bdd24cd791d46c12391b6c9bab876e254"; // <--- PASTE THE TOKEN from the 'API Token' column in your screenshot
const EXOTEL_SUBDOMAIN = "api.exotel.com";
// PASTE YOUR META TOKEN HERE
const WHATSAPP_TOKEN = "EAAZAdwZCN1oWUBQU47ABYOG9TKr4BOxBL8KZB3KzFg8VGctKZAbFXurv2UZBrtDtXQuZBeSZCAGV6kC0jp31OD3k4ZALmvuyZBjJB7cBBvcm4ZA7WRek6HxZC8j2bil56qpDeSkZB9ZAJ4z2fnFZA8vwPSwg6AOu9SJ4vGWEmt4jZA6BvyZAfksVIQNHSBTl1DrDnagaLVhZAGQZDZD"; 
const PHONE_NUMBER_ID = "859484990592429"; 
const VERIFY_TOKEN = "silver_seva_secret"; 

async function getRecordingUrlFromCallSid(callSid) {
    const url = `https://${EXOTEL_SUBDOMAIN}/v1/Accounts/${EXOTEL_API_KEY}/Calls/${callSid}.json`;

    const response = await axios.get(url, {
        auth: {
            username: EXOTEL_API_KEY,
            password: EXOTEL_TOKEN
        }
    });

    return response.data?.Call?.RecordingUrl || null;
}


exports.webhook = functions.https.onRequest(async (req, res) => {
    // A. VERIFY TOKEN (For Facebook Setup)
    if (req.method === "GET") {
        if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
            res.status(200).send(req.query["hub.challenge"]);
        } else {
            res.sendStatus(403);
        }
    } 
    // B. HANDLE INCOMING MESSAGES
    else if (req.method === "POST") {
        try {
            const body = req.body;
            if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                
                const messageObj = body.entry[0].changes[0].value.messages[0];
                const from = messageObj.from; 
                let msgType = messageObj.type;
                let msgBody = "";

                // --- 🎙️ VOICE EXTRACTION ---
                if (msgType === "audio" || msgType === "voice") {
                    console.log("🎙️ Voice detected...");
                    const mediaId = messageObj.audio ? messageObj.audio.id : (messageObj.voice ? messageObj.voice.id : null);
                    
                    if (mediaId) {
                        const transcript = await transcribeAudio(mediaId); 
                        if (transcript) {
                            msgBody = transcript;
                            msgType = "text"; // Treat as text hereafter
                            console.log("📝 Transcript:", msgBody);
                        } else {
                            msgBody = ""; 
                            await sendWhatsApp(from, "⚠️ I couldn't hear that. Please type.");
                        }
                    }
                } 
                else if (msgType === "text") {
                    msgBody = messageObj.text.body;
                }

                // Proceed if we have content
                if (msgBody || msgType === "location" || msgType === "image") {
                    
                    // Check if sender is a Nurse
                    const nurseQuery = await db.collection('nurses').where('phone', '==', from).get();
                    const isNurse = !nurseQuery.empty;

                    if (isNurse) {
                        await handleNurseLogic(nurseQuery.docs[0], messageObj, msgType, msgBody, from);
                    } else {
                        await handleClientLogic(from, messageObj, msgType, msgBody);
                    }
                }
            }
            res.sendStatus(200);
        } catch (e) {
            console.error("Critical Error:", e);
            res.sendStatus(500);
        }
    }
});

// ==========================================
// [ADD THIS] EXOTEL WEBHOOK 1: PROCESS INPUT
// This receives the User's audio, thinks, and creates an MP3.
// ==========================================
// ==========================================
// [FIXED] EXOTEL WEBHOOK 1: PROCESS INPUT
// ==========================================


// ==========================================
// 2. NURSE LOGIC (With NLU)
// ==========================================
// ==========================================
// 2. NURSE LOGIC (With NLU + EHR Logging)
// ==========================================
// ==========================================
// 2. UPDATED NURSE LOGIC (Saves Data for Daily Logs)
// ==========================================
async function handleNurseLogic(nurseDoc, messageObj, msgType, msgBody, from) {
    const nurseData = nurseDoc.data();
    const currentStatus = nurseData.status || "offline"; 

    // GLOBAL STOP COMMAND
    if (msgType === "text" && msgBody.toLowerCase().includes("stop")) {
        const activeJob = await getActiveBookingForNurse(nurseDoc.id);
        if (activeJob) {
            await db.collection('bookings').doc(activeJob.id).update({ status: "completed", completedAt: Date.now() });
            await sendWhatsApp(activeJob.clientPhone, `✅ Service Completed.\nYour nurse has logged off.`);
        }
        await db.collection('nurses').doc(nurseDoc.id).update({ status: "offline" });
        await replySmartly(from, "You are now OFFLINE. Active jobs auto-closed.", msgBody);
        return;
    }

    switch (currentStatus) {
        case "offline":
        case "available":
            if (msgType === "location") {
                await db.collection('nurses').doc(nurseDoc.id).update({
                    status: "available",
                    currentLocation: {
                        lat: messageObj.location.latitude,
                        lng: messageObj.location.longitude,
                        address: messageObj.location.address || "Live Location"
                    },
                    lastActive: Date.now()
                });
                await replySmartly(from, "Location received. You are AVAILABLE. Waiting for bookings.", msgBody);
            } else {
                await replySmartly(from, `Welcome ${nurseData.name}. Send Location to go ONLINE.`, msgBody);
            }
            break;

        case "busy": // Assigned, en route
            const keywords = ["reach", "arrived", "aa gayi", "pahunch", "here"];
            const isManualArrival = (msgType === "text" && keywords.some(w => msgBody.toLowerCase().includes(w)));
            
            // 👇👇👇 UPDATED ARRIVAL LOGIC 👇👇👇
            if (msgType === "location" || isManualArrival) {
                const booking = await getActiveBookingForNurse(nurseDoc.id);
                if (!booking) { 
                    await replySmartly(from, "Error: No active booking found.", msgBody); 
                    return; 
                }
                
                // 1. Get Address Data
                let addressText = "Location Shared via GPS";
                if (msgType === "location" && messageObj.location.address) {
                    addressText = messageObj.location.address;
                } else if (isManualArrival) {
                    addressText = "Manual Arrival ('Reached')";
                }

                // 2. Update Booking with TIMINGS and ADDRESS for the Dashboard
                await db.collection('bookings').doc(booking.id).update({ 
                    status: "nurse_arrived",
                    startedAt: Date.now(), // 🕒 Time Logged Here
                    nurse_location_address: addressText 
                });

                // 3. Update Nurse Status
                await db.collection('nurses').doc(nurseDoc.id).update({ status: "arrived" });
                
                await replySmartly(from, "✅ Arrival Time Logged! Please send a SELFIE to confirm attendance.", msgBody);
            } else {
                await replySmartly(from, "Navigate to patient. Send Location or say 'Reached' when there.", msgBody);
            }
            break;

        case "arrived": // Waiting for selfie
            // 👇👇👇 UPDATED SELFIE LOGIC 👇👇👇
            if (msgType === "image") {
                const mediaId = messageObj.image.id;
                
                // 1. Upload Image to Firebase Storage & Get URL
                const publicUrl = await saveWhatsAppImage(mediaId, nurseDoc.id);

                // 2. Update Booking with PHOTO URL
                const booking = await getActiveBookingForNurse(nurseDoc.id);
                if(booking) {
                    await db.collection('bookings').doc(booking.id).update({ 
                        status: "in_progress",
                        nurse_selfie_url: publicUrl // 📸 Selfie Saved Here
                    });
                }

                // 3. Update Nurse Status
                await db.collection('nurses').doc(nurseDoc.id).update({ status: "on_duty" });

                await replySmartly(from, "📸 Selfie Saved! Duty Started. \n\n📝 **Tip:** Speak or type vitals anytime.", "Selfie sent");
            } else {
                await replySmartly(from, "Please send a photo (Selfie) to start the duty timer.", msgBody);
            }
            break;

        case "on_duty":
            let isJobDone = false;
            if (msgType === "text") {
                isJobDone = await checkNurseCompletionIntent(msgBody);
            }

            if (isJobDone) {
                const booking = await getActiveBookingForNurse(nurseDoc.id);
                if (booking) {
                    await db.collection('bookings').doc(booking.id).update({ status: "completed", completedAt: Date.now() });
                    await sendWhatsApp(booking.clientPhone, `✅ **Service Completed**\nNurse has finished.`);
                }
                await db.collection('nurses').doc(nurseDoc.id).update({ status: "available" });
                await replySmartly(from, "Job marked COMPLETED. You are AVAILABLE.", msgBody);
            } else {
                 const medicalLog = await extractMedicalData(msgBody);

                if (medicalLog.is_medical_update) {
                    const booking = await getActiveBookingForNurse(nurseDoc.id);
                    if (booking) {
                        await db.collection('bookings').doc(booking.id).collection('logs').add({
                            timestamp: Date.now(),
                            raw_text: msgBody,
                            vitals: medicalLog.vitals,
                            summary: medicalLog.summary,
                            nurseId: nurseDoc.id
                        });
                        await replySmartly(from, `✅ **Logged:** ${medicalLog.summary}`, "Log saved");
                    }
                } else {
                    await replySmartly(from, "Duty in progress. Tell me vitals or say 'Done' to finish.", msgBody);
                }
            }
            break;
    }
}

// ==========================================
// 3. CLIENT LOGIC (Booking + Cancel + Reschedule)
// ==========================================
async function handleClientLogic(from, messageObj, msgType, msgBody) {
    // MANUAL RESET
    if (msgType === "text" && msgBody.trim().toUpperCase() === "RESET") {
        const snap = await db.collection('bookings').where('clientPhone', '==', from).where('status', 'in', ['assigned', 'nurse_arrived', 'in_progress']).get();
        const batch = db.batch();
        snap.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled_reset' }));
        await batch.commit();
        await db.collection('conversations').doc(from).delete();
        await sendWhatsApp(from, "🔄 Reset Complete.");
        return;
    }

    // Load History
    const convoRef = db.collection('conversations').doc(from);
    const convoDoc = await convoRef.get();
    let history = convoDoc.exists ? convoDoc.data().history : [];
    let clientCoords = convoDoc.exists ? convoDoc.data().coords : null;

    if (msgType === "location") {
        clientCoords = { lat: messageObj.location.latitude, lng: messageObj.location.longitude };
        history.push({ role: "user", content: "SYSTEM_EVENT: LOCATION_PIN_RECEIVED" });
        await convoRef.set({ history, coords: clientCoords }, { merge: true });
    } else if (msgType === "text") {
        history.push({ role: "user", content: msgBody });
    }

    if (history.length > 10) history = history.slice(-10);

    // --- CHECK FOR ACTIVE BOOKING ---
    const activeBooking = await getActiveBookingForClient(from);

    // A. CLIENT HAS ACTIVE BOOKING (Manage it)
    if (activeBooking) {
        const decision = await manageActiveBooking(history, activeBooking);

        if (decision.action === "cancel_booking") {
            // Cancel Logic
            await db.collection('bookings').doc(activeBooking.id).update({ 
                status: 'cancelled_user', 
                cancellationReason: decision.data.reason || "User requested"
            });
            await db.collection('nurses').doc(activeBooking.assignedNurseId).update({ status: 'available' });
            
            await sendWhatsApp(activeBooking.assignedNursePhone, `❌ **BOOKING CANCELLED**\nClient cancelled. You are AVAILABLE.`);
            await sendWhatsApp(from, "✅ Booking has been cancelled per your request.");
            await convoRef.delete();
        } 
        else if (decision.action === "reschedule_booking") {
            // Reschedule Logic
            await db.collection('bookings').doc(activeBooking.id).update({ time: decision.data.new_time });
            
            await sendWhatsApp(activeBooking.assignedNursePhone, `🗓️ **SCHEDULE UPDATE**\nClient changed time to: ${decision.data.new_time}.`);
            await sendWhatsApp(from, `✅ Time updated to: ${decision.data.new_time}. Nurse notified.`);
        } 
        else {
            // Just a chat reply
            await sendWhatsApp(from, decision.message);
        }
        return;
    }

    // B. NO BOOKING (Create one)
    const aiDecision = await chatWithAI(history);

    if (aiDecision.isBooking) {
        const assignedNurse = await findNearestAvailableNurse(clientCoords.lat, clientCoords.lng);
        if (assignedNurse) {
            await db.collection('bookings').add({
                clientPhone: from, ...aiDecision.data, clientLocation: clientCoords,
                assignedNurseId: assignedNurse.id, assignedNurseName: assignedNurse.name, assignedNursePhone: assignedNurse.phone,
                status: 'assigned', timestamp: Date.now()
            });
            await db.collection('nurses').doc(assignedNurse.id).update({ status: 'busy' });
            
            const bookingDesc = `${aiDecision.data.patient_details} at ${aiDecision.data.time}`;
            
            await sendWhatsApp(from, `✅ **Booking Confirmed!**\n👤 Nurse: ${assignedNurse.name}\n📞 ${assignedNurse.phone}\n📝 ${bookingDesc}`);
            
            // Notify Nurse
            await sendWhatsApp(assignedNurse.phone, `🚑 **NEW DUTY ASSIGNED**\nPatient: ${aiDecision.data.patient_details}\nTime: ${aiDecision.data.time}`);
            await sendWhatsAppLocation(assignedNurse.phone, clientCoords.lat, clientCoords.lng, "Patient Location", aiDecision.data.location);
        } else {
            await sendWhatsApp(from, `⚠️ No nurses nearby.`);
        }
        await convoRef.delete(); 
    } else {
        await sendWhatsApp(from, aiDecision.message);
        history.push({ role: "assistant", content: aiDecision.message });
        await convoRef.set({ history, coords: clientCoords || null });
    }
}

// ==========================================
// 4. AI HELPERS
// ==========================================

// A. BOOKING CREATION AI
async function chatWithAI(history) {
    const systemMessage = { 
        role: "system", 
        content: `You are 'Silver Seva' receptionist.
        LANGUAGE: English or Hinglish (No Devanagari).
        If user sends generic text without location, ask for Location Pin.
        Collect: Time & Patient Details.`
    };

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [systemMessage, ...history], 
        functions: [{
            name: "create_booking",
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
}

// B. BOOKING MANAGEMENT AI (Cancel/Reschedule)
async function manageActiveBooking(history, bookingData) {
    const systemMessage = {
        role: "system",
        content: `You are the 'Silver Seva' assistant managing an EXISTING booking.
        DETAILS: Nurse ${bookingData.assignedNurseName}, Time ${bookingData.time}, Patient ${bookingData.patient_details}.
        RULES:
        1. If user says 'Cancel' or similar, call 'cancel_booking'.
        2. If user says 'Change time' or 'Reschedule', call 'reschedule_booking'.
        3. Otherwise, reply nicely in Hinglish regarding their status.
        4. NEVER Cancel without explicit request.`
    };

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [systemMessage, ...history],
        tools: [
            {
                type: "function",
                function: {
                    name: "cancel_booking",
                    description: "Cancels the active booking",
                    parameters: { type: "object", properties: { reason: { type: "string" } } }
                }
            },
            {
                type: "function",
                function: {
                    name: "reschedule_booking",
                    description: "Reschedules the booking",
                    parameters: { 
                        type: "object", 
                        properties: { new_time: { type: "string" } },
                        required: ["new_time"]
                    }
                }
            }
        ],
        tool_choice: "auto"
    });

    const msg = response.choices[0].message;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const tool = msg.tool_calls[0].function;
        return { action: tool.name, data: JSON.parse(tool.arguments) };
    }
    return { action: "reply", message: msg.content };
}

// C. NURSE INTENT AI (Job Done?)
async function checkNurseCompletionIntent(userText) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "Classify the Nurse's message. Return JSON: { \"is_completed\": true/false }.\n" +
                             "True IF: The nurse conveys the job is done, they are leaving, or patient is handled (e.g., 'kaam ho gaya', 'finished', 'leaving now', 'done', 'chale jaun').\n" +
                             "False IF: They are giving an update or asking a question."
                },
                { role: "user", content: userText }
            ],
            response_format: { type: "json_object" }
        });
        const result = JSON.parse(response.choices[0].message.content);
        return result.is_completed;
    } catch (e) {
        return false;
    }
}

// D. SMART REPLY (Anti-Robot)
async function replySmartly(to, systemStatus, userLastMessage) {
    const userText = userLastMessage || "Hello";
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "You are the friendly AI coordinator for 'Silver Seva'. Rewrite the SYSTEM UPDATE below into a polite response in Hinglish (No Devanagari)." 
                },
                { role: "user", content: `User said: "${userText}"\n\nSYSTEM UPDATE: ${systemStatus}` }
            ]
        });
        await sendWhatsApp(to, completion.choices[0].message.content);
    } catch (e) {
        await sendWhatsApp(to, systemStatus); 
    }
}

// ==========================================
// 5. UTILITY FUNCTIONS
// ==========================================
async function transcribeAudio(mediaId) {
    try {
        console.log(`🎧 Downloading Media ID: ${mediaId}`);
        const urlRes = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaUrl = urlRes.data.url;

        const writer = fs.createWriteStream(path.join(os.tmpdir(), `temp_${mediaId}.ogg`));
        const fileRes = await axios({
            method: 'get', url: mediaUrl, responseType: 'stream',
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }
        });
        fileRes.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const filePath = path.join(os.tmpdir(), `temp_${mediaId}.ogg`);
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath), model: "whisper-1",
        });
        fs.unlinkSync(filePath);
        return transcription.text;
    } catch (e) {
        console.error("Transcription Failed", e);
        return null; 
    }
}

// DB & Geo Helpers
async function getActiveBookingForClient(phone) {
    const snap = await db.collection('bookings').where('clientPhone', '==', phone).where('status', 'in', ['assigned', 'nurse_arrived', 'in_progress']).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function getActiveBookingForNurse(nurseId) {
    const snap = await db.collection('bookings').where('assignedNurseId', '==', nurseId).where('status', 'in', ['assigned', 'nurse_arrived', 'in_progress']).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function findNearestAvailableNurse(clientLat, clientLng) {
    const snap = await db.collection('nurses').where('status', '==', 'available').get();
    if (snap.empty) return null;
    let nearest = null; let minDst = Infinity;
    snap.forEach(doc => {
        const n = { id: doc.id, ...doc.data() };
        if (n.currentLocation) {
            const d = getDistanceFromLatLonInKm(clientLat, clientLng, n.currentLocation.lat, n.currentLocation.lng);
            if (d < minDst) { minDst = d; nearest = n; }
        }
    });
    return nearest;
}
async function sendWhatsApp(to, text) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }, data: { messaging_product: "whatsapp", to: to, type: "text", text: { body: text } } }); } catch (e) {}
}
async function sendWhatsAppLocation(to, lat, lng, name, address) {
    try { await axios({ method: "POST", url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }, data: { messaging_product: "whatsapp", to: to, type: "location", location: { longitude: lng, latitude: lat, name: name, address: address } } }); } catch (e) {}
}
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; var dLat = deg2rad(lat2-lat1); var dLon = deg2rad(lon2-lon1); 
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat1)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function deg2rad(deg) { return deg * (Math.PI/180) }

// E. AI MEDICAL SCRIBE (Extracts BP, Sugar, Meds from text)
async function extractMedicalData(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `You are a Medical Scribe AI. Analyze the nurse's message.
                    Extract vitals (BP, Pulse, Temp, SpO2, Sugar) and key actions (Meds given, Food eaten).
                    
                    Return JSON ONLY:
                    {
                        "is_medical_update": boolean, (Set True ONLY if text clearly contains health stats, medication info, or patient status. False if it's casual chat like "Hello" or "Okay".)
                        "vitals": { "bp": string, "temp": string, "sugar": string, "spo2": string },
                        "summary": "Short professional summary for the doctor/family (e.g., 'BP recorded 120/80, patient had lunch')",
                        "is_critical": boolean (True if vitals are dangerous, e.g. Temp > 102, BP > 160, SpO2 < 90)
                    }`
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });
        const result = JSON.parse(response.choices[0].message.content);
        return result;
    } catch (e) {
        console.error("Medical Extraction Error", e);
        return { is_medical_update: false };
    }
}

// ==========================================
// [ADD THIS] VOICE SPECIFIC HELPERS
// ==========================================



// 2. Generate Human Voice (MP3) & Upload to Storage


// 3. Voice Logic (Short answers, Emergency check)


// 4. Find Nurse by Area Name (Simple Mock)
async function findNearestAvailableNurseByArea(areaName) {
    // In a real app, use Google Maps API to geocode 'areaName' -> Lat/Lng
    // Then query DB. For now, return first available.
    const snap = await db.collection('nurses').where('status', '==', 'available').limit(1).get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ==========================================
// 6. NEW EXOTEL LOGIC (Passthru Test)
// ==========================================
exports.exotelProcess = functions.https.onRequest(async (req, res) => {
    try {
        // Passthru sends data via GET (doc-confirmed)
        const callSid = req.query.CallSid || req.body.CallSid;
        const from = req.query.From || req.body.From;

        console.log("📞 EXOTEL CALLSID:", callSid);

        // 1️⃣ First pass: no CallSid yet usable → welcome
        if (!callSid) {
            return res.status(200).send("OK");
        }

        // 2️⃣ Fetch recording via Call Details API
        const recordingUrl = await getRecordingUrlFromCallSid(callSid);

        // Recording may not be ready yet (documented delay)
        if (!recordingUrl) {
            console.log("⏳ Recording not ready yet");
            return res.status(200).send("OK");
        }

        // 3️⃣ Download audio
        const audioPath = path.join(os.tmpdir(), `voice_${Date.now()}.wav`);
        const writer = fs.createWriteStream(audioPath);

        const audioRes = await axios.get(recordingUrl, { responseType: "stream" });
        audioRes.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });

        // 4️⃣ Whisper transcription
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
        });

        const userText = transcription.text;
        console.log("📝 USER SAID:", userText);

        // 5️⃣ Voice conversation memory
        const convoRef = db.collection("voice_conversations").doc(from);
        const convoDoc = await convoRef.get();
        let history = convoDoc.exists ? convoDoc.data().history : [];

        history.push({ role: "user", content: userText });

        // 6️⃣ Reuse EXISTING AI brain
        const aiDecision = await chatWithAI(history);

        let replyText;

        if (aiDecision.isBooking) {
            const nurse = await findNearestAvailableNurseByArea(aiDecision.data.location);

            await db.collection("bookings").add({
                clientPhone: from,
                ...aiDecision.data,
                assignedNurseId: nurse?.id || "pending",
                status: "assigned",
                timestamp: Date.now(),
                source: "voice_ivr"
            });

            replyText = `Booking confirmed. I have sent the details to your WhatsApp.`;

            await sendWhatsApp(
                from,
                `✅ Voice Booking Confirmed\nTime: ${aiDecision.data.time}`
            );

            await convoRef.delete();
        } else {
            replyText = aiDecision.message;
            history.push({ role: "assistant", content: replyText });
            await convoRef.set({ history });
        }

        // 7️⃣ Exotel Passthru CANNOT speak JSON
        // Just return 200 — speech happens in Greeting using {{bot_reply}}
        res.status(200).json({ bot_reply: replyText });

    } catch (err) {
        console.error("❌ EXOTEL IVR ERROR:", err);
        res.status(200).json({
            bot_reply: "Sorry, something went wrong. Please try again."
        });
    }
});
// ==========================================
// [NEW] HELPER: Save WhatsApp Image to Firebase Storage
// ==========================================
async function saveWhatsAppImage(mediaId, nurseId) {
    try {
        console.log(`📸 Downloading Image ID: ${mediaId}`);
        
        // A. Get Download URL from Meta
        const urlRes = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaUrl = urlRes.data.url;

        // B. Download the Stream
        const response = await axios({
            method: 'get',
            url: mediaUrl,
            responseType: 'stream',
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }
        });

        // C. Upload Stream to Firebase Storage
        const fileName = `selfies/${nurseId}_${Date.now()}.jpg`;
        const file = bucket.file(fileName);
        
        await new Promise((resolve, reject) => {
            response.data.pipe(file.createWriteStream({
                metadata: { contentType: 'image/jpeg' }
            }))
            .on('finish', resolve)
            .on('error', reject);
        });

        // D. Make Public (so the dashboard can see it)
        await file.makePublic();
        
        // E. Return the public URL
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        console.log("✅ Image Saved:", publicUrl);
        return publicUrl;

    } catch (e) {
        console.error("❌ Image Save Failed:", e);
        // Fallback image if upload fails so the dashboard doesn't break
        return "https://cdn-icons-png.flaticon.com/512/3135/3135715.png"; 
    }
}

// Helper: Find nurse by Area Name (since voice doesn't give GPS coords)
