const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
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
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

async function createAdmin() {
  try {
    console.log('🔄 Creating admin user in Firebase Auth...');

    const adminEmail = 'admin@yourdomain.com';
    const adminPassword = 'admin123';

    // Check if admin already exists
    try {
      await admin.auth().getUserByEmail(adminEmail);
      console.log('❌ Admin user already exists in Firebase Auth');
      console.log('   Use the existing credentials or delete the user first');
      return;
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
      console.log('✅ Admin user does not exist, creating new one...');
    }

    // Create user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: 'Administrator',
    });

    console.log('✅ User created in Firebase Auth successfully');
    console.log('   UID:', userRecord.uid);

    // Store additional info in Firestore (no password needed since Firebase Auth handles it)
    const adminData = {
      uid: userRecord.uid,
      name: 'Administrator',
      email: adminEmail,
      role: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('admins').doc(userRecord.uid).set(adminData);

    console.log('✅ Admin data stored in Firestore');
    console.log('');
    console.log('🎉 SUCCESS! Admin user created successfully');
    console.log('');
    console.log('📧 Login Details:');
    console.log('   Email: admin@yourdomain.com');
    console.log('   Password: admin123');
    console.log('');
    console.log('🔗 Admin Panel URL: http://localhost:3000/admin/login');
    console.log('');
    console.log('⚠️  IMPORTANT:');
    console.log('   - Change the password after first login');
    console.log('   - This user is created in both Firebase Auth and Firestore');

  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    console.log('');
    console.log('🔧 Alternative: Create admin manually in Firebase Console:');
    console.log('   1. Go to https://console.firebase.google.com/');
    console.log(`   2. Select project "${process.env.FIREBASE_PROJECT_ID}"`);
    console.log('   3. Go to Authentication');
    console.log('   4. Create user with:');
    console.log('      email: "admin@yourdomain.com"');
    console.log('      password: "admin123"');
    console.log('   5. Go to Firestore Database');
    console.log('   6. Create collection "admins"');
    console.log('   7. Add document with:');
    console.log('      name: "Administrator"');
    console.log('      email: "admin@yourdomain.com"');
  } finally {
    process.exit(0);
  }
}

createAdmin();
