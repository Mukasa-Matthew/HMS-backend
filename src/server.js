const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

// Basic Socket.IO setup for real-time updates (allocations, payments, etc.)
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : '*',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  // In a real app, you would verify a JWT here from socket.handshake.auth.token
  console.log('WebSocket client connected', socket.id);

  socket.on('disconnect', () => {
    console.log('WebSocket client disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  // Simple startup log; in production, consider a proper logger
  console.log(`HMS backend running on port ${PORT}`);
});

module.exports = { server, io };

