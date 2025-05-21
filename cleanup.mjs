import fs from 'fs/promises';
import path from 'path';

// Config
const TORRENT_EXPIRY = 3 * 60 * 60 * 1000; // 3 hours
const TORRENT_FOLDER = path.resolve('./torrents');

async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TORRENT_FOLDER);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TORRENT_FOLDER, file);
      const stats = await fs.stat(filePath);

      if (now - stats.mtimeMs > TORRENT_EXPIRY) {
        await fs.rm(filePath, { recursive: true, force: true });
        console.log(`Deleted expired file/folder: ${filePath}`);
      }
    }
    console.log('Cleanup completed successfully.');
  } catch (err) {
    console.error('Error during cleanup:', err);
  }
}

// Run cleanup
cleanupOldFiles();