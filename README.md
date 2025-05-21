# Torrent Streaming API

A high-performance torrent streaming server built with Node.js and WebTorrent.

## Features

- Stream torrent content directly in the browser
- Download all files as a ZIP archive
- Support for magnet links and .torrent files
- Automatic cleanup of inactive torrents
- Simple web interface for managing torrents

## Installation

1. Make sure you have Node.js 16 or higher installed.
2. Clone or download this repository.
3. Install dependencies:

```bash
npm install
```

## Configuration

Edit the `complete-server-fix.js` file to configure the following settings:

- `PORT`: Server port (default: 80)
- `SERVER_URL`: The public URL of your server
- `MAX_CONNECTIONS`: Maximum number of connections per torrent
- `TORRENT_EXPIRY`: Time after which inactive torrents are removed
- `MAX_TORRENTS`: Maximum number of active torrents

## Usage

Start the server:

```bash
npm start
```

Or run with the cleanup service:

```bash
npm run start:service
```

## API Endpoints

- `GET /status` - Check API status and system information
- `GET /torrents` - List all active torrents
- `GET /magnet?uri={MAGNET_URI}` - Add a torrent using a magnet link
- `POST /upload` - Upload a .torrent file
- `GET /torrent/{INFO_HASH}` - Get information about a specific torrent
- `GET /stream/{INFO_HASH}/{FILE_PATH}` - Stream a file from a torrent
- `GET /download/{INFO_HASH}` - Download all files as a ZIP archive
- `GET /remove/{INFO_HASH}` - Remove a torrent

## Example Usage

### Adding a torrent via magnet link

```javascript
fetch('/magnet?uri=' + encodeURIComponent('magnet:?xt=urn:btih:...'))
  .then(response => response.json())
  .then(data => console.log(data));
```

### Streaming a file

Access `/stream/{INFO_HASH}/{FILE_PATH}` directly in your browser or media player.

## Security Considerations

This API is designed for internal use in trusted environments. It does not implement user authentication or rate limiting by default. When deploying in a production environment, consider adding:

- API key authentication
- Rate limiting
- HTTPS
- Proper firewall rules

## License

MIT