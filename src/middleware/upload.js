const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');

// Ensure upload directories exist
const avatarsDir = path.join(__dirname, '../../public/uploads/avatars');
const photosDir = path.join(__dirname, '../../public/uploads/photos');

[avatarsDir, photosDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Avatar storage config
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '');
    cb(null, `avatar-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${cleanName}${ext}`);
  }
});

// General photo storage config (for screensaver & gallery)
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, photosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '');
    cb(null, `photo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${cleanName}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|gif/;
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mime = file.mimetype.toLowerCase();
  if (allowedTypes.test(ext) && (mime.startsWith('image/') || allowedTypes.test(mime))) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (JPEG, PNG, WebP, GIF) are allowed!'));
  }
};

async function createScreensaverDerivative(originalPath, filename) {
  const derivativeName = `screen-${path.basename(filename, path.extname(filename))}.jpg`;
  const derivativePath = path.join(photosDir, derivativeName);
  await sharp(originalPath)
    .rotate()
    .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(derivativePath);
  return { filename: derivativeName, path: derivativePath };
}

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter
});

const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter
});

module.exports = {
  uploadAvatar,
  uploadPhoto,
  avatarsDir,
  photosDir,
  createScreensaverDerivative
};
