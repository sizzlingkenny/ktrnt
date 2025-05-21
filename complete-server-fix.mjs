// Complete replacement for server.js with fixed stream URLs and ZIP download feature
import { execSync } from 'child_process';
import express from 'express';
import WebTorrent from 'webtorrent';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import multer from 'multer';
import os from 'os';
import { spawn } from 'child_process';
import archiver from 'archiver';

// Start cleanup process
let cleanupProcess;
try {
  cleanupProcess = spawn('node', ['cleanup.js'], { 
    detached: true,
    stdio: 'inherit'
  });
  console.log('Started cleanup process');
} catch (err) {
  console.error('Failed to start cleanup process:', err);
}

// Configuration
const PORT = process.env.PORT || 80;
const SERVER_URL = 'http://155.138.227.136'; // Hardcoded server URL
const MAX_CONNECTIONS = 100;
const TORRENT_EXPIRY = 3 * 60 * 60 * 1000; // 3 hours
const INACTIVE_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_TORRENTS = 20; // Maximum number of active torrents

// Setup Express
const app = express();
app.use(cors());

// Enable logging
const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
console.log = function(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  process.stdout.write(logMessage + '\n');
  logStream.write(logMessage + '\n');
};

console.error = function(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ERROR: ${message}`;
  process.stderr.write(logMessage + '\n');
  logStream.write(logMessage + '\n');
};

// Configure multer for torrent file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
  fileFilter: function (req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== '.torrent') {
      return cb(new Error('Only .torrent files are allowed'));
    }
    cb(null, true);
  }
});

// Initialize WebTorrent client with optimized settings
const client = new WebTorrent({
  maxConns: MAX_CONNECTIONS,  // Maximum number of connections per torrent
  dht: true,      // Enable DHT
  tracker: true,  // Enable trackers
  webSeeds: true  // Enable web seeds
});

// Create necessary directories
const downloadsPath = path.join(__dirname, 'downloads');
const uploadsPath = path.join(__dirname, 'uploads');
const tempPath = path.join(__dirname, 'temp');

if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

if (!fs.existsSync(tempPath)) {
  fs.mkdirSync(tempPath, { recursive: true });
}

// Store last access time for each torrent to enable cleanup
const torrentActivity = new Map();

// Helper functions
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Extract infoHash from a magnet URI
function extractInfoHash(magnetURI) {
  if (!magnetURI) return null;
  
  let infoHash = null;
  if (magnetURI.includes('btih:')) {
    infoHash = magnetURI.split('btih:')[1].split('&')[0].toLowerCase();
  }
  
  return infoHash;
}

// Update activity timestamp for a torrent
function updateTorrentActivity(infoHash) {
  torrentActivity.set(infoHash, Date.now());
}

// Check and remove inactive torrents
function cleanupInactiveTorrents() {
  console.log('Checking for inactive torrents...');
  const now = Date.now();
  let removed = 0;
  
  // Sort torrents by activity (least recently used first)
  const sortedTorrents = Array.from(torrentActivity.entries())
    .sort((a, b) => a[1] - b[1]);
  
  // Remove torrents that exceed the maximum number (oldest first)
  if (client.torrents.length > MAX_TORRENTS) {
    const excessCount = client.torrents.length - MAX_TORRENTS;
    console.log(`Exceeding maximum torrent count by ${excessCount}, removing oldest torrents...`);
    
    for (let i = 0; i < excessCount && i < sortedTorrents.length; i++) {
      const [infoHash] = sortedTorrents[i];
      const torrent = client.get(infoHash);
      
      if (torrent) {
        const torrentName = torrent.name;
        try {
          client.remove(infoHash);
          torrentActivity.delete(infoHash);
          removed++;
          console.log(`Removed excess torrent: ${torrentName} (${infoHash})`);
        } catch (error) {
          console.error(`Error removing excess torrent ${infoHash}:`, error);
        }
      }
    }
  }
  
  // Remove inactive torrents
  for (const [infoHash, lastActive] of torrentActivity.entries()) {
    if (now - lastActive > TORRENT_EXPIRY) {
      const torrent = client.get(infoHash);
      
      if (torrent) {
        const torrentName = torrent.name;
        try {
          client.remove(infoHash);
          torrentActivity.delete(infoHash);
          removed++;
          console.log(`Removed inactive torrent: ${torrentName} (${infoHash})`);
        } catch (error) {
          console.error(`Error removing inactive torrent ${infoHash}:`, error);
        }
      } else {
        // Torrent reference is gone but entry remains in activity map
        torrentActivity.delete(infoHash);
      }
    }
  }
  
  // Log memory usage
  const memUsage = process.memoryUsage();
  console.log(`Memory usage: ${formatBytes(memUsage.rss)} / ${formatBytes(memUsage.heapTotal)} (${Math.round(memUsage.heapUsed / memUsage.heapTotal * 100)}%)`);
  console.log(`Active torrents: ${client.torrents.length}, Removed: ${removed}`);
}

// Set up periodic cleanup
setInterval(cleanupInactiveTorrents, INACTIVE_CHECK_INTERVAL);

// Basic routes
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Torrent Streaming API</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          h2 { color: #666; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 4px; }
          a { color: #0066cc; }
        </style>
      </head>
      <body>
        <h1>Torrent Streaming API</h1>
        <p>Server is running. Below are the available endpoints:</p>
        
        <h2>API Endpoints:</h2>
        <ul>
          <li><a href="/status">/status</a> - Check API status</li>
          <li><a href="/torrents">/torrents</a> - List all active torrents</li>
          <li><code>/magnet?uri={MAGNET_URI}</code> - Add a torrent using a magnet link</li>
          <li><code>/torrentfile?torrent={TORRENT_URL}</code> - Add a torrent from a URL</li>
          <li><code>/torrent/{INFO_HASH}</code> - Get information about a specific torrent</li>
          <li><code>/stream/{INFO_HASH}/{FILE_PATH}</code> - Stream a file from a torrent</li>
          <li><code>/download/{INFO_HASH}</code> - Download all files as a ZIP archive</li>
          <li><code>/remove/{INFO_HASH}</code> - Remove a torrent</li>
        </ul>
        
        <h2>Example Usage:</h2>
        <pre>
// Add a torrent using a magnet link
fetch('/magnet?uri=magnet:?xt=urn:btih:...')
  .then(response => response.json())
  .then(data => console.log(data));

// Check torrent status
fetch('/torrent/{INFO_HASH}?json=true')
  .then(response => response.json())
  .then(data => console.log(data));
        </pre>
      </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  const memUsage = process.memoryUsage();
  const cpuInfo = os.cpus();
  const loadAvg = os.loadavg();
  
	// Get disk usage
	const diskInfo = { available: 'Unknown', used: 'Unknown', total: 'Unknown' };
	try {
	  const df = execSync('df -h / | tail -1').toString().trim().split(/\s+/);
	  diskInfo.total = df[1];
	  diskInfo.used = df[2];
	  diskInfo.available = df[3];
	} catch (err) {
	  console.error('Error getting disk usage:', err);
	}

  
  res.json({ 
    status: 'OK', 
    version: '1.2.0',
    torrents: {
      active: client.torrents.length,
      tracked: torrentActivity.size
    },
    uptime: Math.floor(process.uptime()),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: cpuInfo.length,
      loadAvg: loadAvg,
      totalmem: formatBytes(os.totalmem()),
      freemem: formatBytes(os.freemem()),
      disk: diskInfo
    },
    memory: {
      rss: formatBytes(memUsage.rss),
      heapTotal: formatBytes(memUsage.heapTotal),
      heapUsed: formatBytes(memUsage.heapUsed),
      external: formatBytes(memUsage.external)
    }
  });
});

// List all active torrents
app.get('/torrents', (req, res) => {
  const torrents = client.torrents.map(torrent => {
    return {
      name: torrent.name,
      infoHash: torrent.infoHash,
      progress: Math.round(torrent.progress * 1000) / 10, // progress as percentage with 1 decimal
      downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
      numPeers: torrent.numPeers,
      uploaded: formatBytes(torrent.uploaded),
      downloaded: formatBytes(torrent.downloaded),
      ratio: Math.round((torrent.uploaded / (torrent.downloaded || 1)) * 100) / 100,
      timeRemaining: torrent.timeRemaining ? Math.round(torrent.timeRemaining / 1000) : 0,
      files: torrent.files.length,
      size: formatBytes(torrent.length),
      url: `${SERVER_URL}/torrent/${torrent.infoHash}`,
      zipUrl: `${SERVER_URL}/download/${torrent.infoHash}`
    };
  });

  if (req.query.json === 'true') {
    res.json(torrents);
  } else {
    // HTML response
    let html = `
      <html>
        <head>
          <title>Active Torrents</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; }
            h1 { color: #333; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
            th { background-color: #f2f2f2; }
            tr:hover { background-color: #f5f5f5; }
            .progress-bar { width: 100px; height: 10px; background-color: #eee; border-radius: 5px; overflow: hidden; }
            .progress-fill { height: 100%; background-color: #4CAF50; }
            .button { display: inline-block; padding: 6px 12px; text-decoration: none; background-color: #4CAF50; color: white; border-radius: 4px; margin-right: 5px; }
            .button.red { background-color: #f44336; }
            .button:hover { opacity: 0.8; }
          </style>
        </head>
        <body>
          <h1>Active Torrents (${torrents.length})</h1>
          <table>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Progress</th>
              <th>Speed</th>
              <th>Peers</th>
              <th>Actions</th>
            </tr>
    `;
    
    torrents.forEach(torrent => {
      html += `
        <tr>
          <td>${torrent.name}</td>
          <td>${torrent.size}</td>
          <td>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${torrent.progress}%;"></div>
            </div>
            ${torrent.progress}%
          </td>
          <td>${torrent.downloadSpeed}</td>
          <td>${torrent.numPeers}</td>
          <td>
            <a class="button" href="/torrent/${torrent.infoHash}">View</a>
            <a class="button" href="/download/${torrent.infoHash}">Download ZIP</a>
          </td>
        </tr>
      `;
    });
    
    html += `
          </table>
        </body>
      </html>
    `;
    
    res.send(html);
  }
});

// Add a magnet torrent with immediate response
app.get('/magnet', (req, res) => {
  const { uri } = req.query;
  const wantJson = req.query.json === 'true';
  
  if (!uri) {
    return res.status(400).send('Missing magnet URI');
  }
  
  console.log('Request for magnet URI:', uri);
  
  // Extract info hash from magnet link
  const infoHash = extractInfoHash(uri);
  if (!infoHash) {
    return res.status(400).send('Invalid magnet URI');
  }
  
  // Check if we already have this torrent
  const existingTorrent = client.get(infoHash);
  
  if (existingTorrent) {
    console.log('Using existing torrent:', existingTorrent.name);
    updateTorrentActivity(infoHash);
    return sendTorrentResponse(existingTorrent);
  }
  
  // Check if maximum torrent limit reached
  if (client.torrents.length >= MAX_TORRENTS) {
    cleanupInactiveTorrents(); // Force cleanup
    
    if (client.torrents.length >= MAX_TORRENTS) {
      if (wantJson) {
        return res.status(503).json({
          error: 'Too many active torrents',
          message: 'Server has reached maximum torrent capacity. Try again later.'
        });
      } else {
        return res.status(503).send('Server has reached maximum torrent capacity. Try again later.');
      }
    }
  }
  
  // Respond immediately with processing status
  if (wantJson) {
    res.json({
      status: 'processing',
      infoHash: infoHash,
      message: 'Torrent is being processed. Check with /torrent/' + infoHash
    });
  } else {
    res.send(`
      <html>
        <head>
          <title>Processing Torrent</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1 { color: #333; }
          </style>
        </head>
        <body>
          <h1>Processing Torrent</h1>
          <p>The torrent is being processed. Please wait...</p>
          <p>Info Hash: ${infoHash}</p>
          <p>Check status at: <a href="/torrent/${infoHash}">/torrent/${infoHash}</a></p>
          <script>
            // Refresh the page after 5 seconds to check torrent status
            setTimeout(() => {
              window.location.href = '/torrent/${infoHash}';
            }, 5000);
          </script>
        </body>
      </html>
    `);
  }
  
  // Add the torrent in the background with timeout
  const addTimeout = setTimeout(() => {
    console.error(`Torrent add operation timed out for ${infoHash}`);
  }, 60000); // 1 minute timeout
  
  let torrentOptions = { 
    path: downloadsPath,
    maxWebConns: 10 // Limit web connections to prevent overload
  };
  
  client.add(uri, torrentOptions, (torrent) => {
    clearTimeout(addTimeout);
    console.log(`Added torrent: ${torrent.name} (${torrent.infoHash})`);
    updateTorrentActivity(infoHash);
    
    // Prioritize the first 10% and last 10% of each file for quicker streaming
    torrent.files.forEach(file => {
      const totalPieces = Math.ceil(file.length / torrent.pieceLength);
      
      // Prioritize first 10% of pieces for quick start
      const firstPieces = Math.ceil(totalPieces * 0.1);
      file.prioritizePieces(0, firstPieces);
      
      // Also prioritize last pieces for formats that need end data (like mp4)
      const lastPieces = Math.max(0, totalPieces - Math.ceil(totalPieces * 0.1));
      if (lastPieces > firstPieces) {
        file.prioritizePieces(lastPieces, totalPieces);
      }
    });
    
    // Handle torrent errors
    torrent.on('error', (err) => {
      console.error(`Torrent error (${torrent.infoHash}): ${err.message}`);
    });
    
    // Handle download completion
    torrent.on('done', () => {
      console.log(`Torrent completed: ${torrent.name} (${torrent.infoHash})`);
    });
  }).on('error', (err) => {
    clearTimeout(addTimeout);
    console.error('Error processing magnet URI:', err);
  });
  
  // Function to send torrent response
  function sendTorrentResponse(torrent) {
    
    // Prepare file information with absolute URLs
    const files = torrent.files.map(file => {
      const streamPath = `/stream/${torrent.infoHash}/${encodeURIComponent(file.path)}`;
      
      return {
        name: file.name,
        path: file.path,
        length: file.length,
        // Ensure we have the full absolute URL to the streaming endpoint
        streamUrl: `${SERVER_URL}${streamPath}`
      };
    });
    
    // Create response
    const response = {
      name: torrent.name,
      infoHash: torrent.infoHash,
      files: files,
      zipUrl: `${SERVER_URL}/download/${torrent.infoHash}`,
      progress: Math.round(torrent.progress * 100) / 100,
      downloaded: formatBytes(torrent.downloaded),
      downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
      numPeers: torrent.numPeers
    };
    
    // Return appropriate format
    if (wantJson) {
      res.json(response);
    } else {
      // Simple HTML response
      let html = `
        <html>
          <head>
            <title>${torrent.name}</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
              h1 { color: #333; }
              .file-item { margin-bottom: 10px; }
              .file-link { color: #0066cc; text-decoration: none; }
              .file-link:hover { text-decoration: underline; }
              .size { color: #666; font-size: 0.9em; }
              .download-button { 
                display: inline-block;
                padding: 10px 15px;
                background-color: #4CAF50;
                color: white;
                text-decoration: none;
                border-radius: 4px;
                margin-top: 20px;
              }
              .download-button:hover {
                background-color: #45a049;
              }
            </style>
          </head>
          <body>
            <h1>${torrent.name}</h1>
            <p>Info Hash: ${torrent.infoHash}</p>
            <p>Progress: ${Math.round(torrent.progress * 100)}%</p>
            <p>Download Speed: ${formatBytes(torrent.downloadSpeed)}/s</p>
            <p>Peers: ${torrent.numPeers}</p>
            
            <a href="${response.zipUrl}" class="download-button">Download All Files as ZIP</a>
            
            <h2>Files (${files.length}):</h2>
            <ul>
      `;
      
      files.forEach(file => {
        const fileSize = formatBytes(file.length);
        html += `
          <li class="file-item">
            <a class="file-link" href="${file.streamUrl}" target="_blank">${file.name}</a>
            <span class="size">(${fileSize})</span>
          </li>
        `;
      });
      
      html += `
            </ul>
          </body>
        </html>
      `;
      res.send(html);
    }
  }
});

// Add a torrent from a URL
app.get('/torrentfile', (req, res) => {
  const { torrent } = req.query;
  const wantJson = req.query.json === 'true';
  
  if (!torrent) {
    return res.status(400).send('Missing torrent URL parameter');
  }
  
  // Check if maximum torrent limit reached
  if (client.torrents.length >= MAX_TORRENTS) {
    cleanupInactiveTorrents(); // Force cleanup
    
    if (client.torrents.length >= MAX_TORRENTS) {
      if (wantJson) {
        return res.status(503).json({
          error: 'Too many active torrents',
          message: 'Server has reached maximum torrent capacity. Try again later.'
        });
      } else {
        return res.status(503).send('Server has reached maximum torrent capacity. Try again later.');
      }
    }
  }
  
  console.log('Downloading torrent from URL:', torrent);
  
  // Respond immediately
  if (wantJson) {
    res.json({
      status: 'processing',
      url: torrent,
      message: 'Torrent is being processed. Check /torrents for status.'
    });
  } else {
    res.send(`
      <html>
        <head>
          <title>Processing Torrent</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1 { color: #333; }
          </style>
        </head>
        <body>
          <h1>Processing Torrent</h1>
          <p>Downloading and processing the torrent file. Please wait...</p>
          <p>URL: ${torrent}</p>
          <p>Check <a href="/torrents">torrents list</a> in a few seconds.</p>
          <script>
            // Refresh and go to torrents page after 5 seconds
            setTimeout(() => {
              window.location.href = '/torrents';
            }, 5000);
          </script>
        </body>
      </html>
    `);
  }
  
import * as http from 'http';
import * as https from 'https';
import path from 'path';
import fs from 'fs';

// ... other imports and code ...

// Process the torrent in the background
try {
  const httpLib = torrent.startsWith('https') ? https : http;

  // Special handling for YTS and other sites
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    timeout: 10000 // 10 second timeout
  };

  httpLib.get(torrent, options, (response) => {
    if (response.statusCode === 301 || response.statusCode === 302) {
      // Handle redirects
      console.log('Redirect to:', response.headers.location);
      // You could follow the redirect here if needed
      return;
    }

    if (response.statusCode !== 200) {
      console.error(`Failed to download torrent file. Status code: ${response.statusCode}`);
      return;
    }

    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));

    response.on('end', () => {
      const buffer = Buffer.concat(chunks);
      console.log(`Downloaded torrent file: ${buffer.length} bytes`);

      if (buffer.length === 0) {
        console.error('Downloaded empty torrent file');
        return;
      }

      // Save to a temporary file (optional)
      const tempPath = path.join(uploadsPath, `temp-${Date.now()}.torrent`);
      fs.writeFileSync(tempPath, buffer);

      let torrentOptions = { 
        path: downloadsPath,
        maxWebConns: 10 // Limit web connections
      };

      const addTimeout = setTimeout(() => {
        console.error(`Torrent add operation timed out for file ${tempPath}`);
      }, 60000); // 1 minute timeout

      // Add the torrent
      client.add(buffer, torrentOptions, (torrent) => {
        clearTimeout(addTimeout);
        console.log(`Added torrent from URL: ${torrent.name} (${torrent.infoHash})`);
        updateTorrentActivity(torrent.infoHash);

        // Prioritize the first 10% and last 10% of each file
        torrent.files.forEach(file => {
          const totalPieces = Math.ceil(file.length / torrent.pieceLength);
          const firstPieces = Math.ceil(totalPieces * 0.1);
          file.prioritizePieces(0, firstPieces);

          const lastPieces = Math.max(0, totalPieces - Math.ceil(totalPieces * 0.1));
          if (lastPieces > firstPieces) {
            file.prioritizePieces(lastPieces, totalPieces);
          }
        });

        // Clean up the temporary file
        fs.unlink(tempPath, err => {
          if (err) console.error('Error deleting temp file:', err);
        });
      }).on('error', (err) => {
        clearTimeout(addTimeout);
        console.error('Error processing torrent file:', err);
        // Clean up the temporary file
        fs.unlink(tempPath, () => {});
      });
    });
  }).on('error', (err) => {
    console.error('Error downloading torrent file:', err);
  }).on('timeout', () => {
    console.error('Download request timed out');
  });
} catch (error) {
  console.error('Unexpected error processing torrent:', error);
}

});

// Upload a torrent file
app.post('/upload', upload.single('torrent'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No torrent file uploaded');
  }
  
  // Check if maximum torrent limit reached
  if (client.torrents.length >= MAX_TORRENTS) {
    cleanupInactiveTorrents(); // Force cleanup
    
    if (client.torrents.length >= MAX_TORRENTS) {
      return res.status(503).send('Server has reached maximum torrent capacity. Try again later.');
    }
  }
  
  const torrentPath = req.file.path;
  console.log('Torrent file uploaded to:', torrentPath);
  
  try {
    const torrentBuffer = fs.readFileSync(torrentPath);
    
    let torrentOptions = { 
      path: downloadsPath,
      maxWebConns: 10 // Limit web connections
    };
    
    const addTimeout = setTimeout(() => {
      console.error(`Torrent add operation timed out for file ${torrentPath}`);
    }, 60000); // 1 minute timeout
    
    client.add(torrentBuffer, torrentOptions, (torrent) => {
      clearTimeout(addTimeout);
      console.log(`Added torrent from upload: ${torrent.name} (${torrent.infoHash})`);
      updateTorrentActivity(torrent.infoHash);
      
      // Clean up the uploaded file
      fs.unlink(torrentPath, err => {
        if (err) console.error('Error deleting uploaded file:', err);
      });
      
      res.redirect(`/torrent/${torrent.infoHash}`);
    }).on('error', (err) => {
      clearTimeout(addTimeout);
      console.error('Error processing uploaded torrent:', err);
      res.status(500).send(`Error processing uploaded torrent: ${err.message}`);
      
      // Clean up on error
      fs.unlink(torrentPath, () => {});
    });
  } catch (err) {
    console.error('Error reading uploaded torrent file:', err);
    res.status(500).send(`Error reading uploaded torrent file: ${err.message}`);
    
    // Clean up on error
    fs.unlink(torrentPath, () => {});
  }
});

// Get info for a specific torrent by info hash
app.get('/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const wantJson = req.query.json === 'true';
  
  // Find the torrent
  const torrent = client.get(infoHash);
  
  if (!torrent) {
    if (wantJson) {
      return res.json({
        status: 'pending',
        infoHash: infoHash,
        message: 'Torrent is still being processed or not found.'
      });
    } else {
      return res.send(`
        <html>
          <head>
            <title>Processing Torrent</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
              h1 { color: #333; }
            </style>
          </head>
          <body>
            <h1>Processing Torrent</h1>
            <p>The torrent is still being processed or not found.</p>
            <p>Info Hash: ${infoHash}</p>
            <p>Check back in a few seconds.</p>
            <script>
              // Refresh the page after 5 seconds
              setTimeout(() => {
                window.location.reload();
              }, 5000);
            </script>
          </body>
        </html>
      `);
    }
  }
  
  // Update activity timestamp
  updateTorrentActivity(infoHash);
  
  // Prepare file information with absolute URLs
  const files = torrent.files.map(file => {
    const streamPath = `/stream/${torrent.infoHash}/${encodeURIComponent(file.path)}`;
    
    return {
      name: file.name,
      path: file.path,
      length: file.length,
      // Ensure we have the full absolute URL to the streaming endpoint
      streamUrl: `${SERVER_URL}${streamPath}`
    };
  });
  
  // Create response
  const response = {
    name: torrent.name,
    infoHash: torrent.infoHash,
    files: files,
    zipUrl: `${SERVER_URL}/download/${torrent.infoHash}`,
    progress: Math.round(torrent.progress * 100) / 100,
    downloaded: formatBytes(torrent.downloaded),
    downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
    numPeers: torrent.numPeers
  };
  
  // Return appropriate format
  if (wantJson) {
    res.json(response);
  } else {
    // Simple HTML response
    let html = `
      <html>
        <head>
          <title>${torrent.name}</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1 { color: #333; }
            .file-item { margin-bottom: 10px; }
            .file-link { color: #0066cc; text-decoration: none; }
            .file-link:hover { text-decoration: underline; }
            .size { color: #666; font-size: 0.9em; }
            .download-button { 
              display: inline-block;
              padding: 10px 15px;
              background-color: #4CAF50;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              margin-top: 20px;
            }
            .download-button:hover {
              background-color: #45a049;
            }
          </style>
        </head>
        <body>
          <h1>${torrent.name}</h1>
          <p>Info Hash: ${torrent.infoHash}</p>
          <p>Progress: ${Math.round(torrent.progress * 100)}%</p>
          <p>Download Speed: ${formatBytes(torrent.downloadSpeed)}/s</p>
          <p>Peers: ${torrent.numPeers}</p>
          
          <a href="${response.zipUrl}" class="download-button">Download All Files as ZIP</a>
          
          <h2>Files (${files.length}):</h2>
          <ul>
    `;
    
    files.forEach(file => {
      const fileSize = formatBytes(file.length);
      html += `
        <li class="file-item">
          <a class="file-link" href="${file.streamUrl}" target="_blank">${file.name}</a>
          <span class="size">(${fileSize})</span>
        </li>
      `;
    });
    
    html += `
          </ul>
        </body>
      </html>
    `;
    res.send(html);
  }
});

// Stream a file from a torrent
app.get('/stream/:infoHash/:filePath(*)', (req, res) => {
  const { infoHash } = req.params;
  const filePath = req.params.filePath;
  
  console.log(`Stream request for ${infoHash} / ${filePath}`);
  
  if (!infoHash || !filePath) {
    return res.status(400).send('Missing info hash or file path');
  }
  
  // Find the torrent
  const torrent = client.get(infoHash);
  
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }
  
  // Update activity timestamp
  updateTorrentActivity(infoHash);
  
  // Find the file in the torrent
  const file = torrent.files.find(f => f.path === filePath);
  
  if (!file) {
    return res.status(404).send('File not found in torrent');
  }
  
  // Stream the file
  const range = req.headers.range;
  const fileSize = file.length;
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    
    // Limit chunk size for better streaming performance
    const maxChunkSize = 1024 * 1024 * 2; // 2MB
    const adjustedEnd = start + Math.min(chunkSize, maxChunkSize) - 1;
    
    console.log(`Range request: ${start}-${adjustedEnd}/${fileSize}`);
    
    const headers = {
      'Content-Range': `bytes ${start}-${adjustedEnd}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': adjustedEnd - start + 1,
      'Content-Type': getContentType(file.name)
    };
    
    res.writeHead(206, headers);
    
    // Create stream for the specific range
    const fileStream = file.createReadStream({
      start: start,
      end: adjustedEnd
    });
    
    fileStream.pipe(res);
    
    fileStream.on('error', (err) => {
      console.error(`Error streaming file: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send(`Streaming error: ${err.message}`);
      } else {
        res.end();
      }
    });
  } else {
    // Handle non-range requests (full file)
    const headers = {
      'Content-Length': fileSize,
      'Content-Type': getContentType(file.name)
    };
    
    // Get file extension for download behavior
    const ext = path.extname(file.name).toLowerCase();
    
    // Force download for certain file types
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.iso', '.img', '.apk'].includes(ext)) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(file.name)}"`;
    }
    
    res.writeHead(200, headers);
    
    const fileStream = file.createReadStream();
    fileStream.pipe(res);
    
    fileStream.on('error', (err) => {
      console.error(`Error streaming file: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send(`Streaming error: ${err.message}`);
      } else {
        res.end();
      }
    });
  }
});

// NEW FEATURE: Download all torrent files as ZIP
app.get('/download/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  
  console.log(`ZIP download request for ${infoHash}`);
  
  // Find the torrent
  const torrent = client.get(infoHash);
  
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }
  
  // Update activity timestamp
  updateTorrentActivity(infoHash);
  
  // Set response headers
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(torrent.name)}.zip"`);
  
  // Create zip archive
  const archive = archiver('zip', {
    zlib: { level: 6 } // Compression level (0-9)
  });
  
  // Pipe archive data to the response
  archive.pipe(res);
  
  // Handle archive errors
  archive.on('error', (err) => {
    console.error('ZIP creation error:', err);
    res.status(500).send('Error creating ZIP file');
  });
  
  // Add all files to the archive
  const processingMessage = `Creating ZIP for ${torrent.files.length} files. This might take some time...`;
  console.log(processingMessage);
  
  // Track progress for large torrents
  let filesAdded = 0;
  
  // Create a list of downloaded files (those that are 100% complete)
  const completedFiles = torrent.files.filter(file => {
    return fs.existsSync(path.join(torrent.path, file.path));
  });
  
  // Add files one by one
  completedFiles.forEach(file => {
    try {
      const filePath = path.join(torrent.path, file.path);
      
      // Check if file actually exists
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file.path });
        filesAdded++;
        
        // Log progress for large torrents
        if (completedFiles.length > 10 && filesAdded % 10 === 0) {
          console.log(`ZIP progress: ${filesAdded}/${completedFiles.length} files added`);
        }
      } else {
        console.warn(`File not found for ZIP: ${filePath}`);
      }
    } catch (err) {
      console.error(`Error adding file to ZIP: ${file.path}`, err);
    }
  });
  
  // Finalize the archive and send the response
  archive.finalize();
  
  console.log(`ZIP file created with ${filesAdded} files for ${torrent.name}`);
});

// Remove a torrent
app.get('/remove/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  
  if (!infoHash) {
    return res.status(400).send('Missing info hash');
  }
  
  console.log(`Remove request for torrent ${infoHash}`);
  
  // Find the torrent
  const torrent = client.get(infoHash);
  
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }
  
  // Remove the torrent
  const torrentName = torrent.name;
  try {
    client.remove(infoHash);
    torrentActivity.delete(infoHash);
    console.log(`Removed torrent: ${torrentName} (${infoHash})`);
    
    if (req.query.json === 'true') {
      res.json({
        success: true,
        message: `Torrent ${torrentName} removed successfully`
      });
    } else {
      res.redirect('/torrents');
    }
  } catch (error) {
    console.error(`Error removing torrent ${infoHash}:`, error);
    
    if (req.query.json === 'true') {
      res.status(500).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).send(`Error removing torrent: ${error.message}`);
    }
  }
});

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'public')));

// Handle shutdown gracefully
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
  console.log('Shutting down torrent API server...');
  
  // Clean up all torrents
  client.torrents.forEach(torrent => {
    try {
      client.remove(torrent.infoHash);
    } catch (err) {
      console.error(`Error removing torrent during shutdown: ${err.message}`);
    }
  });
  
  // Close the server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds if server hasn't closed
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Helper function to determine content type
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.webm': 'video/webm',
    '.m3u8': 'application/x-mpegURL',
    '.ts': 'video/MP2T',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.txt': 'text/plain',
    '.srt': 'text/plain',
    '.vtt': 'text/vtt',
    '.ass': 'text/plain',
    '.ssa': 'text/plain'
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}

// Start the server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Torrent Streaming API server running on port ${PORT}`);
  console.log(`Web interface available at http://localhost:${PORT}/index.html`);
  console.log(`NOTE: In Replit environment, access via the webview URL`);
});

// Increase timeout for long connections
server.timeout = 10 * 60 * 1000; // 10 minutes