const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const { calculatePrice } = require('./utils/priceCalculator');
require("dotenv").config();

// Initialize Firebase Admin
const admin = require('firebase-admin');

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
};

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OTP storage and rate limiting
const otpStore = new Map();
const OTP_EXPIRY = 5 * 60 * 1000; // 5 minutes in milliseconds
const verifiedNumbers = new Map(); // Track verified numbers for cooldown

// Rate limiting middleware that only applies to verified numbers
const verifiedNumberRateLimiter = (req, res, next) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return next();
  
  const formatted = normalizePhone(phoneNumber);
  if (!formatted) return next();
  
  const verifiedData = verifiedNumbers.get(formatted);
  
  // If number was verified and cooldown hasn't expired
  if (verifiedData && Date.now() < verifiedData.cooldownUntil) {
    const timeLeft = Math.ceil((verifiedData.cooldownUntil - Date.now()) / 1000 / 60);
    return res.status(429).json({ 
      error: `Așteaptă ${timeLeft} minute înainte de a cere un nou cod.` 
    });
  }
  
  next();
};

const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000", // React dev server
    methods: ["GET", "POST"],
  },
});
 
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

// Store connected admin users
let connectedAdmins = new Map();

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("admin-login", (adminData) => {
    connectedAdmins.set(socket.id, {
      id: adminData.id,
      email: adminData.email,
      connectedAt: new Date(),
    });
    console.log("Admin logged in:", adminData.email);
    socket.join("admin-room");
  });

  socket.on("admin-logout", () => {
    connectedAdmins.delete(socket.id);
    socket.leave("admin-room");
    console.log("Admin logged out:", socket.id);
  });

  socket.on("disconnect", () => {
    connectedAdmins.delete(socket.id);
    console.log("User disconnected:", socket.id);
  });
});

// Function to notify connected admin users
const notifyAdmins = (eventType, data) => {
  const adminCount = connectedAdmins.size;
  console.log(`Notifying ${adminCount} admin(s) of event: ${eventType}`);

  if (adminCount > 0) {
    io.to("admin-room").emit("admin-notification", {
      type: eventType,
      data: data,
      timestamp: new Date(),
    });
  }
};
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  console.log("Auth Header:", authHeader);
  console.log("Token:", token ? "Present" : "Missing");

  if (!token) {
    console.log("No token provided");
    return res.status(401).json({ error: "Access token required" });
  }

  try {
    const decoded = require("jsonwebtoken").verify(
      token,
      process.env.JWT_SECRET
    );
    console.log("Token decoded successfully:", decoded);
    req.admin = decoded;
    next();
  } catch (error) {
    console.error("JWT verification error:", error.message);
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};
const normalizePhone = (raw) => {
  if (!raw) return null;

  const digits = String(raw).replace(/\D/g, ''); // păstrăm doar cifre

  if (!digits) return null;

  // 07xxxxxxxx  (clasic RO cu 0)
  if (digits.length === 10 && digits.startsWith('07')) {
    return `+4${digits}`;           // +407xxxxxxxx
  }

  // 7xxxxxxxx (fără 0, user deștept sau leneș)
  if (digits.length === 9 && digits.startsWith('7')) {
    return `+40${digits}`;          // +407xxxxxxxx
  }

  // 407xxxxxxxx (fără +, dar cu 40)
  if (digits.length === 11 && digits.startsWith('407')) {
    return `+${digits}`;            // +407xxxxxxxx
  }

  // +407xxxxxxxx deja corect → ajunge aici ca "407xxxxxxxx"
  if (digits.length === 11 && digits.startsWith('407')) {
    return `+${digits}`;
  }

  // fallback: orice altceva, dar măcar E.164 cu +
  return `+${digits}`;
};

 
const generatePriceUrl = (token) => {
  return `${process.env.FRONTEND_URL}/price-offer/${token}`;
};

// Generate and send OTP
app.post('/api/otp/send', verifiedNumberRateLimiter, async (req, res) => {
  try {
    let { phoneNumber } = req.body;
    console.log('Original phone number:', phoneNumber);
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

         const formatted = normalizePhone(phoneNumber);
    if (!formatted) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    phoneNumber = formatted;
    console.log('Formatted phone number:', phoneNumber);


    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiryTime = Date.now() + OTP_EXPIRY;
    
    // Store OTP along with any user data from the request
    otpStore.set(phoneNumber, { 
      otp, 
      expiryTime,
      userData: req.body.userData // Store any additional user data
    });

    // Send OTP via Twilio
    await twilioClient.messages.create({
      body: `Acesta este codul pentru a afla pretul din oferta Weesuals Studio: ${otp}
       Daca nu ai cerut niciun pret, ignora acest mesaj!`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    res.status(200).json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP
app.post('/api/otp/verify', async (req, res) => {
  try {
        let { phoneNumber, otp } = req.body;
    
    if (!phoneNumber || !otp) {
      return res.status(400).json({ error: 'Phone number and OTP are required' });
    }

    const formatted = normalizePhone(phoneNumber);
    if (!formatted) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    phoneNumber = formatted;

    const storedData = otpStore.get(phoneNumber);

    
    if (!storedData) {
      return res.status(400).json({ error: 'No OTP found for this number' });
    }

       const { otp: storedOtp, expiryTime } = storedData;

    // Check if OTP is expired
    if (Date.now() > expiryTime) {
      otpStore.delete(phoneNumber);
      return res.status(400).json({ error: 'OTP has expired' });
    }

    // Normalize OTP values (în caz că vin ca number / cu spații)
    const inputOtp = String(otp).replace(/\D/g, '').trim();
    const savedOtp = String(storedOtp).replace(/\D/g, '').trim();

    console.log('Comparing OTP:', { inputOtp, savedOtp });

    if (inputOtp.length !== 4 || savedOtp.length !== 4) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }

    if (inputOtp !== savedOtp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }


    // Get the user data that was stored when OTP was generated
    const userData = storedData.userData || {};
    
    // Generate a session token
    const sessionToken = uuidv4();
    
    // Save user data to Firestore
    try {
      const userRef = db.collection('verifiedUsers').doc(phoneNumber);
      await userRef.set({
        phoneNumber,
        ...userData,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      console.log(`User data saved for ${phoneNumber}`);
    } catch (dbError) {
      console.error('Error saving user data to Firestore:', dbError);
      // Don't fail the request if Firestore save fails
    }
    
    // Set cooldown for this number (5 minutes from now)
    verifiedNumbers.set(phoneNumber, {
      cooldownUntil: Date.now() + (5 * 60 * 1000) // 5 minutes cooldown
    });
    
    // Clear OTP from memory
    otpStore.delete(phoneNumber);
    
    res.status(200).json({ 
      message: 'OTP verified successfully',
      sessionToken,
      expiresIn: OTP_EXPIRY
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Routes
// Handle price request
app.post("/api/price-request", async (req, res) => {
  try {
    const { email, priceData } = req.body;

    if (!email || !priceData) {
      return res.status(400).json({ error: 'Email and price data are required' });
    }

    // Generate token and save only minimal data to Firestore
    const token = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now

    // Recalculate prices on the server side to ensure consistency
    const { videoCost, postCost, adCost, totalPrice } = calculatePrice(
      priceData.videosPerWeek,
      priceData.postsPerWeek,
      priceData.includeAdManagement
    );

    const priceOffer = {
      email,
      token,
      priceData: {
        videosPerWeek: priceData.videosPerWeek,
        postsPerWeek: priceData.postsPerWeek,
        includeAdManagement: priceData.includeAdManagement,
        videoCost,
        postCost,
        adCost,
        totalPrice,
        requestedAt: serverTimestamp()
      },
      expiresAt: expiresAt.toISOString(),
      isUsed: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    // Save to Firestore
    await setDoc(doc(db, 'priceOffers', token), priceOffer);
    console.log('Price offer token saved to Firestore');

    const priceUrl = generatePriceUrl(token);
    res.json({ success: true, token, priceUrl });
  } catch (error) {
    console.error('Error processing price request:', error);
    res.status(500).json({ error: 'Failed to process price request' });
  }
});

// Get price offer by token
app.get("/api/price-offer/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const offerRef = doc(db, 'priceOffers', token);
    const offerSnap = await getDoc(offerRef);
    
    if (!offerSnap.exists()) {
      return res.status(404).json({ error: 'Price offer not found' });
    }
    
    const offer = offerSnap.data();
    
    // Check if offer is expired
    const now = new Date();
    const expiresAt = new Date(offer.expiresAt);
    
    if (now > expiresAt) {
      return res.status(400).json({ error: 'This price offer has expired' });
    }
    
    // Mark as used and update the offer in Firestore
    if (!offer.isUsed) {
      await updateDoc(offerRef, {
        isUsed: true,
        usedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      
      console.log('Price offer marked as used in Firestore:', { token, email: offer.email });
      offer.usedAt = new Date().toISOString();
    }

    // Return the price data in the expected format
    res.json({ 
      success: true, 
      offer: {
        priceData: {
          videosPerWeek: offer.priceData.videosPerWeek,
          postsPerWeek: offer.priceData.postsPerWeek,
          includeAdManagement: offer.priceData.includeAdManagement,
          videoCost: offer.priceData.videoCost,
          postCost: offer.priceData.postCost,
          adCost: offer.priceData.adCost,
          totalPrice: offer.priceData.totalPrice,
          requestedAt: offer.priceData.requestedAt
        },
        email: offer.email,
        token: offer.token,
        isUsed: offer.isUsed,
        usedAt: offer.usedAt,
        expiresAt: offer.expiresAt,
        createdAt: offer.createdAt
      } 
    });
  } catch (error) {
    console.error('Error fetching price offer:', error);
    res.status(500).json({ error: 'Failed to fetch price offer' });
  }
});

// Contact form submission
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, service, budget, description } = req.body;
    if (!name || !email || !service || !budget || !description) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const contactData = {
      name,
      email,
      service,
      budget,
      description,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "new",
    };

    const docRef = await db.collection("contacts").add(contactData);

    // Notify admins of new contact submission
    notifyAdmins("new-contact", {
      id: docRef.id,
      ...contactData,
    });

    res.status(201).json({
      success: true,
      message: "Contact form submitted successfully",
      id: docRef.id,
    });
  } catch (error) {
    console.error("Error submitting contact form:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/contacts", authenticateToken, async (req, res) => {
  try {
    const snapshot = await db
      .collection("contacts")
      .orderBy("timestamp", "desc")
      .get();

    const contacts = [];
    snapshot.forEach((doc) => {
      contacts.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.json({ success: true, contacts });
  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/contacts/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("contacts").doc(id).delete();

    // Notify admins of deleted contact
    notifyAdmins("contact-deleted", { id });

    res.json({ success: true, message: "Contact deleted successfully" });
  } catch (error) {
    console.error("Error deleting contact:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Verify credentials with Firebase Auth
    let userRecord;
    try {
      // Firebase Auth handles password verification automatically
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      throw error;
    }

    // Check if user exists in our admin collection
    const adminDoc = await db.collection("admins").doc(userRecord.uid).get();

    if (!adminDoc.exists) {
      return res.status(401).json({ error: "User is not authorized as admin" });
    }

    const adminData = adminDoc.data();

    // Generate JWT token for API access (no expiration)
    const token = require("jsonwebtoken").sign(
      { uid: userRecord.uid, email: userRecord.email, role: "admin" },
      process.env.JWT_SECRET
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      admin: {
        id: userRecord.uid,
        email: userRecord.email,
        name: adminData.name,
        role: adminData.role,
      },
    });
  } catch (error) {
    console.error("Error during admin login:", error);
    res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

app.get("/api/admin/users", authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.collection("admins").get();
    const admins = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      // Exclude sensitive information like password
      const { password, ...adminWithoutPassword } = data;
      admins.push({
        id: doc.id,
        ...adminWithoutPassword,
      });
    });

    res.json({ success: true, admins });
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/admin/users", authenticateToken, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email, and password are required" });
    }

    // Check if admin already exists in Auth
    try {
      await admin.auth().getUserByEmail(email);
      return res
        .status(400)
        .json({ error: "Admin with this email already exists" });
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }
      // User doesn't exist, which is good - we can create them
    }

    // Create user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password, // Firebase Auth will handle its own hashing
      displayName: name,
    });

    // Store additional info in firestore (no password needed since Firebase Auth handles it)
    const adminData = {
      uid: userRecord.uid,
      name,
      email,
      role: "admin",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("admins").doc(userRecord.uid).set(adminData);

    // Notify admins of new user
    notifyAdmins("new-admin-user", {
      id: userRecord.uid,
      uid: userRecord.uid,
      name,
      email,
      role: "admin",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      success: true,
      message: "Admin user created successfully in Firebase Auth",
      id: userRecord.uid,
      email: email,
    });
  } catch (error) {
    console.error("Error creating admin user:", error);
    res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

app.delete("/api/admin/users/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Delete from Firebase Auth
    await admin.auth().deleteUser(id);

    // Delete from Firestore
    await db.collection("admins").doc(id).delete();

    // Notify admins of deleted user
    notifyAdmins("admin-user-deleted", { id });

    res.json({
      success: true,
      message: "Admin user deleted successfully from both Auth and Firestore",
    });
  } catch (error) {
    console.error("Error deleting admin user:", error);
    res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

// Get all verified users
app.get('/api/admin/verified-users', authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.collection('verifiedUsers').orderBy('requestedAt', 'desc').get();
    const users = [];
    
    snapshot.forEach(doc => {
      users.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json(users);
  } catch (error) {
    console.error('Error fetching verified users:', error);
    res.status(500).json({ error: 'Failed to fetch verified users' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
