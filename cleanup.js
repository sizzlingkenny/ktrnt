// Cleanup script for torrent files and temporary data
const fs = require('fs');
const path = require('path');

// Configuration
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const DIRECTORIES = [
  path.join(__dirname, 'downloads'),
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'temp')
];

console.log('Starting cleanup service...');

function cleanup() {
  console.log(`Running cleanup at ${new Date().toISOString()}`);
  
  DIRECTORIES.forEach(dir => {
    if (!fs.existsSync(dir)) {
      console.log(`Directory ${dir} does not exist, skipping`);
      return;
    }
    
    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      let count = 0;
      
      files.forEach(file => {
        const filePath = path.join(dir, file);
        
        try {
          const stats = fs.statSync(filePath);
          
          // Skip directories
          if (stats.isDirectory()) return;
          
          const age = now - stats.mtimeMs;
          
          if (age > MAX_AGE) {
            fs.unlinkSync(filePath);
            count++;
            console.log(`Removed old file: ${filePath}`);
          }
        } catch (err) {
          console.error(`Error processing file ${filePath}:`, err);
        }
      });
      
      console.log(`Cleaned up ${count} files in ${dir}`);
    } catch (err) {
      console.error(`Error cleaning up directory ${dir}:`, err);
    }
  });
}

// Run cleanup immediately and then on schedule
cleanup();
setInterval(cleanup, CLEANUP_INTERVAL);

process.on('SIGINT', () => {
  console.log('Cleanup service terminated');
  process.exit(0);
});

// Keep process running
process.stdin.resume();