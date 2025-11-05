const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();
const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000", // React dev server
    methods: ["GET", "POST"],
  },
});

// Middleware
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

// Routes
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
