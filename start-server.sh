#!/bin/bash

# Start the torrent streaming API server
echo "Starting Torrent Streaming API..."

# Create necessary directories if they don't exist
mkdir -p uploads downloads temp

# Start the cleanup process in the background
node cleanup.js &
CLEANUP_PID=$!

# Start the main server
node complete-server-fix.js

# If server exits, kill the cleanup process
kill $CLEANUP_PID