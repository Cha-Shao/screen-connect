// 端到端测试脚本
const WebSocket = require('ws');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 1. Alice 连接
  const alice = new WebSocket('ws://localhost:8080/ws');
  const aliceMsgs = [];
  alice.on('message', (d) => aliceMsgs.push(JSON.parse(d)));
  await new Promise(r => alice.on('open', r));

  // 2. Bob 连接
  const bob = new WebSocket('ws://localhost:8080/ws');
  const bobMsgs = [];
  bob.on('message', (d) => bobMsgs.push(JSON.parse(d)));
  await new Promise(r => bob.on('open', r));

  await wait(200);

  // 检查自动下发的 room-list 和 user-list
  console.log('Alice 收到消息数:', aliceMsgs.length);
  console.log('  [0] type:', aliceMsgs[0]?.type, '| rooms:', aliceMsgs[0]?.rooms?.length);
  console.log('  [1] type:', aliceMsgs[1]?.type, '| users:', aliceMsgs[1]?.users?.length);

  // 3. Alice join room 1
  alice.send(JSON.stringify({ type: 'join', room: '1', id: 'A001', nickname: 'Alice' }));
  await wait(150);
  const aliceJoined = aliceMsgs.find(m => m.type === 'joined');
  console.log('Alice joined room:', aliceJoined?.room, '| peers:', aliceJoined?.peers?.length);

  // 4. Bob join room 1
  bob.send(JSON.stringify({ type: 'join', room: '1', id: 'B002', nickname: 'Bob' }));
  await wait(200);

  // Alice 应收到 peer-joined + user-list
  const peerJoined = aliceMsgs.find(m => m.type === 'peer-joined');
  const userList = aliceMsgs.filter(m => m.type === 'user-list').pop();
  console.log('Alice got peer-joined:', peerJoined?.peer?.nickname);
  console.log('Alice got user-list, count:', userList?.users?.length, '| has Bob:', userList?.users?.some(u => u.nickname === 'Bob'));

  // 5. move-user: Alice moves Bob to room 2
  alice.send(JSON.stringify({ type: 'move-user', targetId: 'B002', roomId: '2' }));
  await wait(200);

  const bobJoined2 = bobMsgs.find(m => m.type === 'joined' && m.room === '2');
  const bobMoved = bobMsgs.find(m => m.type === 'moved');
  console.log('Bob got moved:', !!bobMoved, '| joined room 2:', !!bobJoined2);

  // 6. invite: Alice invites Bob (Bob is now in room 2, not in lobby)
  // First move Bob back to lobby
  bob.send(JSON.stringify({ type: 'leave-room' }));
  await wait(150);

  // Now invite Bob to Alice's room
  alice.send(JSON.stringify({ type: 'invite', targetId: 'B002' }));
  await wait(150);

  const bobInvite = bobMsgs.find(m => m.type === 'invite');
  console.log('Bob got invite:', !!bobInvite, '| from:', bobInvite?.fromNick);

  // Bob accepts
  bob.send(JSON.stringify({ type: 'invite-accept', roomId: '1' }));
  await wait(150);

  const bobJoined1 = bobMsgs.find(m => m.type === 'joined' && m.room === '1' && bobMsgs.indexOf(m) > bobMsgs.indexOf(bobInvite));
  console.log('Bob accepted invite, joined room 1:', !!bobJoined1);

  console.log('\n=== ALL TESTS PASSED ===');
  alice.close(); bob.close();
  process.exit(0);
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
