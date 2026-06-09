/**
 * Script de seed — peuple la base MongoDB avec des données de démo.
 * Exécuter avec : npx ts-node src/seed/seed.ts
 *
 * Prérequis MongoDB Atlas :
 *   1. Autoriser votre IP dans Network Access (0.0.0.0/0 pour tout autoriser)
 *   2. Vérifier que l'utilisateur a les droits readWrite sur la base
 */
import * as mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI manquant dans .env');
  process.exit(1);
}

const UserSchema = new mongoose.Schema(
  { email: String, password: String, pseudo: String, role: String },
  { timestamps: true },
);
const PostSchema = new mongoose.Schema(
  {
    author_id: mongoose.Types.ObjectId, title: String, content: String,
    location: String, type: String, isAnonymous: Boolean,
    image_url: String, isActive: Boolean, isReported: Boolean, reportReasons: [String],
  },
  { timestamps: true },
);
const CommentSchema = new mongoose.Schema(
  { post_id: mongoose.Types.ObjectId, author_id: mongoose.Types.ObjectId, content: String, isAnonymous: Boolean },
  { timestamps: true },
);

async function seed() {

  await mongoose.connect(MONGODB_URI!, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 30000,
  });

  const UserModel = mongoose.models['User'] || mongoose.model('User', UserSchema);
  const PostModel = mongoose.models['Post'] || mongoose.model('Post', PostSchema);
  const CommentModel = mongoose.models['Comment'] || mongoose.model('Comment', CommentSchema);

  await UserModel.deleteMany({});
  await PostModel.deleteMany({});
  await CommentModel.deleteMany({});

  const adminPwd  = await bcrypt.hash('Admin2026!', 12);
  const modPwd    = await bcrypt.hash('Modo2026!', 12);
  const userPwd   = await bcrypt.hash('User2026!', 12);

  const [admin, moderateur, user1, user2] = await (UserModel.insertMany as any)([
    { email: 'admin@alertproche.cm',       password: adminPwd, pseudo: 'AdminAP',       role: 'Admin' },
    { email: 'moderateur@alertproche.cm',  password: modPwd,   pseudo: 'ModAP',         role: 'Moderateur' },
    { email: 'marie@example.cm',           password: userPwd,  pseudo: 'Marie_Cam',     role: 'Standard' },
    { email: 'citoyen@example.cm',         password: userPwd,  pseudo: 'CitoyenDouala', role: 'Standard' },
  ]);

  const posts = await (PostModel.insertMany as any)([
    {
      author_id: user1._id,
      title: 'URGENT – Disparition de Tchinda Noémie, 8 ans – Yaoundé Centre',
      content: `Ma fille Noémie a disparu hier soir vers 18h dans le quartier Melen à Yaoundé. Elle portait une robe rose avec des fleurs blanches et des sandales blanches en plastique.\n\nElle mesurait environ 1m20 pour 25 kg. Elle a les cheveux nattés avec des perles rouges.\n\nSa disparition a été constatée lors de son retour de l'école. Si vous avez des informations, contactez la famille ou les autorités.`,
      location: 'Yaoundé', type: 'Disparition', isAnonymous: false,
      isActive: true, isReported: false, reportReasons: [],
    },
    {
      author_id: user2._id,
      title: "Témoignage : réseau de travail d'enfants démantelé à Douala Bepanda",
      content: `J'ai été témoin d'une situation préoccupante dans le quartier Bepanda. Des enfants âgés de 7 à 12 ans travaillaient dans des conditions inhumaines dans un atelier de couture clandestin.\n\nLes autorités ont été alertées et une descente a eu lieu le lendemain.`,
      location: 'Douala', type: 'Abus', isAnonymous: false,
      isActive: true, isReported: false, reportReasons: [],
    },
    {
      author_id: user1._id,
      title: "Sensibilisation : reconnaître les signes d'abus sur un enfant",
      content: `Il est crucial que chaque citoyen sache identifier les signaux d'alerte.\n\nSignes physiques : blessures inexpliquées, vêtements inadaptés, malnutrition visible.\n\nSignes comportementaux : repli sur soi, agressivité soudaine, peur des adultes.`,
      location: 'National', type: 'Prevention', isAnonymous: false,
      isActive: true, isReported: false, reportReasons: [],
    },
    {
      author_id: user2._id,
      title: 'Alerte enlèvement – Jumelles disparues – Garoua',
      content: `Deux fillettes jumelles âgées de 6 ans ont disparu de leur domicile familial à Garoua, quartier Yelwa.\n\nElles s'appellent Fatima et Aïcha. Description : teint clair, cheveux nattés, portaient des robes identiques jaunes.`,
      location: 'Garoua', type: 'Disparition', isAnonymous: false,
      isActive: true, isReported: true, reportReasons: ['Fausse information'],
    },
    {
      author_id: user1._id,
      title: 'Vos droits face aux abus : guide juridique pour les familles',
      content: `En tant que citoyen, vous pouvez signaler tout abus à l'encontre d'un mineur auprès du tribunal de grande instance.\n\nDémarches :\n1. Rédigez une plainte écrite\n2. Joignez les preuves disponibles\n3. Déposez au parquet du tribunal`,
      location: 'National', type: 'Prevention', isAnonymous: false,
      isActive: true, isReported: false, reportReasons: [],
    },
    {
      author_id: user2._id,
      title: 'Disparition signalée – Garçon de 11 ans – Bafoussam',
      content: `Un enfant répond au prénom de Kevin et aurait disparu depuis vendredi dernier. Dernier lieu connu : école primaire publique de Bafoussam centre.\n\nDescription : environ 1m40, corpulence normale, cheveux courts, portait un uniforme scolaire bleu et blanc.`,
      location: 'Bafoussam', type: 'Disparition', isAnonymous: true,
      isActive: true, isReported: false, reportReasons: [],
    },
  ]);

  await (CommentModel.insertMany as any)([
    {
      post_id: posts[0]._id, author_id: moderateur._id,
      content: "Avez-vous contacté la brigade de gendarmerie du quartier ? Il est important d'agir dans les premières 24h.",
      isAnonymous: false,
    },
    {
      post_id: posts[0]._id, author_id: user2._id,
      content: "J'ai partagé l'information dans mon réseau. Courage à la famille.",
      isAnonymous: true,
    },
    {
      post_id: posts[1]._id, author_id: admin._id,
      content: 'Les services sociaux ont été informés. Merci pour ce témoignage courageux.',
      isAnonymous: false,
    },
    {
      post_id: posts[2]._id, author_id: user2._id,
      content: 'Merci pour ce guide. Je vais le partager dans mon quartier.',
      isAnonymous: false,
    },
  ]);

  

  await mongoose.disconnect();
  setTimeout(() => process.exit(0), 500);
}

seed().catch(err => {

  if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') {
    // console.error('\n💡 Solutions possibles :');
    // console.error('   1. MongoDB Atlas → Network Access → Ajouter votre IP (ou 0.0.0.0/0)');
    // console.error('   2. Vérifier que l\'URI dans .env est correcte');
    // console.error('   3. Vérifier votre connexion internet');
    // console.error('   4. Utiliser MongoDB local : MONGODB_URI=mongodb://localhost:27017/alertproche');
  }
  process.exit(1);
});
