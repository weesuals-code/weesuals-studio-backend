const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "fir-bb85e",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://fir-bb85e.firebaseio.com"
});

const db = admin.firestore();

async function setupFirstAdmin() {
  try {
    console.log('Setting up first admin user...');

    // Check if admin already exists
    const adminSnapshot = await db.collection('admins').limit(1).get();

    if (!adminSnapshot.empty) {
      console.log('Admin user already exists. Exiting...');
      return;
    }

    // Create default admin user
    const defaultAdmin = {
      name: 'Administrator',
      email: 'admin@yourdomain.com', // Change this to your email
      password: 'admin123', // Change this to a secure password
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('admins').add(defaultAdmin);

    console.log('✅ Default admin user created successfully!');
    console.log('📧 Email:', defaultAdmin.email);
    console.log('🔑 Password:', defaultAdmin.password);
    console.log('🆔 Admin ID:', docRef.id);
    console.log('\n⚠️  IMPORTANT: Please change the default password after first login!');
    console.log('   Update the password in Firebase Console or through the admin panel.');

  } catch (error) {
    console.error('❌ Error setting up admin user:', error);
  } finally {
    process.exit(0);
  }
}

setupFirstAdmin();
