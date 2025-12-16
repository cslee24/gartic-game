const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// 방 데이터 저장 (메모리)
const rooms = new Map();

console.log(`WebSocket 서버 시작: 포트 ${PORT}`);

wss.on('connection', (ws) => {
    console.log('새 클라이언트 연결');
    
    ws.userId = null;
    ws.roomId = null;
    ws.userName = '익명';

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (e) {
            console.error('메시지 파싱 오류:', e);
        }
    });

    ws.on('close', () => {
        console.log('클라이언트 연결 해제');
        handleDisconnect(ws);
    });
});

function handleMessage(ws, message) {
    const { type, payload } = message;

    switch (type) {
        case 'CREATE_ROOM':
            createRoom(ws, payload);
            break;
        case 'JOIN_ROOM':
            joinRoom(ws, payload);
            break;
        case 'SET_USERNAME':
            setUsername(ws, payload);
            break;
        case 'START_GAME':
            startGame(ws);
            break;
        case 'SUBMIT_PROMPT':
            submitPrompt(ws, payload);
            break;
        case 'SUBMIT_DRAWING':
            submitDrawing(ws, payload);
            break;
        case 'SUBMIT_GUESS':
            submitGuess(ws, payload);
            break;
        case 'NEW_GAME':
            newGame(ws);
            break;
    }
}

function createRoom(ws, { userId }) {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const room = {
        id: roomId,
        hostId: userId,
        state: 'lobby',
        currentRound: 0,
        users: [],
        books: []
    };
    
    rooms.set(roomId, room);
    
    ws.userId = userId;
    ws.roomId = roomId;
    
    ws.send(JSON.stringify({
        type: 'ROOM_CREATED',
        payload: { roomId, room }
    }));
    
    console.log(`방 생성: ${roomId}`);
}

function joinRoom(ws, { roomId, userId }) {
    const room = rooms.get(roomId);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'ERROR',
            payload: { message: '존재하지 않는 방입니다.' }
        }));
        return;
    }
    
    ws.userId = userId;
    ws.roomId = roomId;
    
    // 이미 참여한 유저인지 확인
    if (!room.users.find(u => u.id === userId)) {
        room.users.push({
            id: userId,
            name: '익명_' + userId.substring(0, 4),
            isReady: false
        });
    }
    
    broadcastToRoom(roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
    
    console.log(`유저 ${userId} 방 ${roomId} 참여`);
}

function setUsername(ws, { userName }) {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    
    ws.userName = userName;
    
    const user = room.users.find(u => u.id === ws.userId);
    if (user) {
        user.name = userName;
        user.isReady = true;
    }
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function startGame(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.hostId !== ws.userId) return;
    if (room.users.length < 2) return;
    
    room.state = 'prompt';
    room.currentRound = 0;
    room.books = [];
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function submitPrompt(ws, { prompt }) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state !== 'prompt') return;
    
    // 이미 제출했는지 확인
    if (room.books.find(b => b.starterId === ws.userId)) return;
    
    const user = room.users.find(u => u.id === ws.userId);
    
    room.books.push({
        starterId: ws.userId,
        starterName: user ? user.name : '익명',
        chain: [{
            round: 0,
            type: 'text',
            content: prompt,
            creatorId: ws.userId
        }]
    });
    
    // 모든 유저가 제출했는지 확인
    if (room.books.length === room.users.length) {
        room.currentRound = 1;
        room.state = 'drawing';
    }
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function submitDrawing(ws, { drawing, targetStarterId }) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state !== 'drawing') return;
    
    const book = room.books.find(b => b.starterId === targetStarterId);
    if (!book) return;
    
    // 이미 이번 라운드에 제출했는지 확인
    if (book.chain.length >= room.currentRound + 1) return;
    
    book.chain.push({
        round: room.currentRound,
        type: 'drawing',
        content: drawing,
        creatorId: ws.userId
    });
    
    checkRoundComplete(room);
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function submitGuess(ws, { guess, targetStarterId }) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state !== 'guessing') return;
    
    const book = room.books.find(b => b.starterId === targetStarterId);
    if (!book) return;
    
    // 이미 이번 라운드에 제출했는지 확인
    if (book.chain.length >= room.currentRound + 1) return;
    
    book.chain.push({
        round: room.currentRound,
        type: 'text',
        content: guess,
        creatorId: ws.userId
    });
    
    checkRoundComplete(room);
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function checkRoundComplete(room) {
    const expectedChainLength = room.currentRound + 1;
    const allComplete = room.books.every(b => b.chain.length >= expectedChainLength);
    
    if (allComplete) {
        const nextRound = room.currentRound + 1;
        
        if (nextRound >= room.users.length) {
            room.state = 'reveal';
        } else {
            room.currentRound = nextRound;
            room.state = (nextRound % 2 === 1) ? 'guessing' : 'drawing';
        }
    }
}

function newGame(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.hostId !== ws.userId) return;
    
    room.state = 'lobby';
    room.currentRound = 0;
    room.books = [];
    room.users.forEach(u => u.isReady = false);
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function handleDisconnect(ws) {
    if (!ws.roomId) return;
    
    const room = rooms.get(ws.roomId);
    if (!room) return;
    
    // 게임 중이 아닐 때만 유저 제거
    if (room.state === 'lobby') {
        room.users = room.users.filter(u => u.id !== ws.userId);
        
        // 방이 비었으면 삭제
        if (room.users.length === 0) {
            rooms.delete(ws.roomId);
            console.log(`방 삭제: ${ws.roomId}`);
            return;
        }
        
        // 호스트가 나갔으면 다음 사람이 호스트
        if (room.hostId === ws.userId && room.users.length > 0) {
            room.hostId = room.users[0].id;
        }
    }
    
    broadcastToRoom(ws.roomId, {
        type: 'ROOM_UPDATE',
        payload: { room }
    });
}

function broadcastToRoom(roomId, message) {
    const messageStr = JSON.stringify(message);
    
    wss.clients.forEach(client => {
        if (client.roomId === roomId && client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// 30분마다 빈 방 정리
setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, roomId) => {
        // 연결된 클라이언트가 없는 방 삭제
        let hasConnectedClient = false;
        wss.clients.forEach(client => {
            if (client.roomId === roomId) hasConnectedClient = true;
        });
        
        if (!hasConnectedClient) {
            rooms.delete(roomId);
            console.log(`빈 방 정리: ${roomId}`);
        }
    });
}, 30 * 60 * 1000);
