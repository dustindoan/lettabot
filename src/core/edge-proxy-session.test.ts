import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { EdgeProxySession, type EdgeProxyConfig } from './edge-proxy-session.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { TriggerContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock ChannelAdapter */
function mockAdapter(id = 'signal', name = 'Signal'): ChannelAdapter {
  return {
    id,
    name,
    onMessage: undefined as any,
    onCommand: undefined as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    sendFile: vi.fn().mockResolvedValue({ messageId: 'file-1' }),
    setTypingIndicator: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelAdapter;
}

/** Spin up a local HTTP server that acts as a mock upstream lettabotd */
function createMockUpstream(handler: (req: any, body: string) => { status: number; body: string; headers?: Record<string, string> }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const result = handler(req, body);
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(result.headers || {}) };
        res.writeHead(result.status, headers);
        res.end(result.body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Unit tests (no network — mock fetch)
// ---------------------------------------------------------------------------

describe('EdgeProxySession', () => {
  describe('channel registration', () => {
    it('registers a channel and wires onMessage', () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      const adapter = mockAdapter();
      session.registerChannel(adapter);

      expect(adapter.onMessage).toBeTypeOf('function');
      expect(adapter.onCommand).toBeTypeOf('function');
      expect(session.getStatus().channels).toEqual(['signal']);
    });

    it('registers multiple channels', () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      session.registerChannel(mockAdapter('signal', 'Signal'));
      session.registerChannel(mockAdapter('telegram', 'Telegram'));

      expect(session.getStatus().channels).toEqual(['signal', 'telegram']);
    });
  });

  describe('getStatus', () => {
    it('returns edge-proxy prefixed agentId', () => {
      const session = new EdgeProxySession({ name: 'Wally', upstreamUrl: 'http://localhost:9999' });
      const status = session.getStatus();
      expect(status.agentId).toBe('edge-proxy:Wally');
      expect(status.conversationId).toBeNull();
    });
  });

  describe('setAgentId / reset', () => {
    it('are no-ops that do not throw', () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      expect(() => session.setAgentId('whatever')).not.toThrow();
      expect(() => session.reset()).not.toThrow();
    });
  });

  describe('deliverToChannel', () => {
    it('sends text to the correct channel', async () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      const adapter = mockAdapter();
      session.registerChannel(adapter);

      const msgId = await session.deliverToChannel('signal', 'chat-123', { text: 'hello' });
      expect(adapter.sendMessage).toHaveBeenCalledWith({ chatId: 'chat-123', text: 'hello' });
      expect(msgId).toBe('msg-1');
    });

    it('prefixes displayName when set', async () => {
      const session = new EdgeProxySession({
        name: 'test',
        upstreamUrl: 'http://localhost:9999',
        displayName: 'Wally',
      });
      const adapter = mockAdapter();
      session.registerChannel(adapter);

      await session.deliverToChannel('signal', 'chat-123', { text: 'hello' });
      expect(adapter.sendMessage).toHaveBeenCalledWith({ chatId: 'chat-123', text: 'Wally: hello' });
    });

    it('sends file when filePath provided', async () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      const adapter = mockAdapter();
      session.registerChannel(adapter);

      const msgId = await session.deliverToChannel('signal', 'chat-123', {
        filePath: '/tmp/photo.jpg',
        kind: 'image',
        text: 'a photo',
      });
      expect(adapter.sendFile).toHaveBeenCalledWith({
        chatId: 'chat-123',
        filePath: '/tmp/photo.jpg',
        caption: 'a photo',
        kind: 'image',
      });
      expect(msgId).toBe('file-1');
    });

    it('throws for unknown channel', async () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      await expect(session.deliverToChannel('nope', 'chat', { text: 'hi' })).rejects.toThrow('Channel not found: nope');
    });

    it('throws when neither text nor filePath provided', async () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      session.registerChannel(mockAdapter());
      await expect(session.deliverToChannel('signal', 'chat', {})).rejects.toThrow('Either text or filePath');
    });
  });

  describe('lastMessageTarget and lastUserMessageTime', () => {
    it('starts as null', () => {
      const session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://localhost:9999' });
      expect(session.getLastMessageTarget()).toBeNull();
      expect(session.getLastUserMessageTime()).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests (real HTTP server as mock upstream)
// ---------------------------------------------------------------------------

describe('EdgeProxySession integration', () => {
  let server: Server;
  let session: EdgeProxySession;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  describe('sendToAgent', () => {
    it('sends message to upstream and returns response', async () => {
      let receivedBody: any;
      const upstream = await createMockUpstream((req, body) => {
        receivedBody = JSON.parse(body);
        return {
          status: 200,
          body: JSON.stringify({ success: true, response: 'Hello from upstream' }),
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const ctx: TriggerContext = { type: 'user_message', sourceUserId: 'alice-1', sourceChatId: 'chat-1' };
      const response = await session.sendToAgent('Hi there', ctx);

      expect(response).toBe('Hello from upstream');
      expect(receivedBody).toEqual({ message: 'Hi there', userId: 'alice-1' });
    });

    it('includes API key header when configured', async () => {
      let receivedHeaders: any;
      const upstream = await createMockUpstream((req) => {
        receivedHeaders = req.headers;
        return {
          status: 200,
          body: JSON.stringify({ success: true, response: 'ok' }),
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({
        name: 'test',
        upstreamUrl: upstream.url,
        apiKey: 'my-secret',
      });

      await session.sendToAgent('test', { type: 'user_message', sourceUserId: 'u1' });
      expect(receivedHeaders['x-api-key']).toBe('my-secret');
    });

    it('throws on HTTP error', async () => {
      const upstream = await createMockUpstream(() => ({
        status: 500,
        body: 'Internal server error',
      }));
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      await expect(session.sendToAgent('hi')).rejects.toThrow('Upstream error 500');
    });

    it('throws when upstream returns success: false', async () => {
      const upstream = await createMockUpstream(() => ({
        status: 200,
        body: JSON.stringify({ success: false, error: 'Agent not found' }),
      }));
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      await expect(session.sendToAgent('hi')).rejects.toThrow('Agent not found');
    });

    it('uses sourceChatId when sourceUserId is absent', async () => {
      let receivedBody: any;
      const upstream = await createMockUpstream((_req, body) => {
        receivedBody = JSON.parse(body);
        return {
          status: 200,
          body: JSON.stringify({ success: true, response: 'ok' }),
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      await session.sendToAgent('hi', { type: 'user_message', sourceChatId: 'chat-fallback' });
      expect(receivedBody.userId).toBe('chat-fallback');
    });

    it('defaults userId to "unknown" when no context', async () => {
      let receivedBody: any;
      const upstream = await createMockUpstream((_req, body) => {
        receivedBody = JSON.parse(body);
        return {
          status: 200,
          body: JSON.stringify({ success: true, response: 'ok' }),
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      await session.sendToAgent('hi');
      expect(receivedBody.userId).toBe('unknown');
    });
  });

  describe('streamToAgent', () => {
    it('parses SSE stream into StreamMsg objects', async () => {
      const upstream = await createMockUpstream(() => {
        const events = [
          'data: {"type":"reasoning","content":"thinking..."}\n\n',
          'data: {"type":"assistant","content":"Hello"}\n\n',
          'data: {"type":"assistant","content":" world"}\n\n',
          'data: {"type":"result","success":true,"result":"Hello world"}\n\n',
        ].join('');
        return {
          status: 200,
          body: events,
          headers: { 'Content-Type': 'text/event-stream' },
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const msgs: any[] = [];
      for await (const msg of session.streamToAgent('test')) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(4);
      expect(msgs[0]).toEqual({ type: 'reasoning', content: 'thinking...' });
      expect(msgs[1]).toEqual({ type: 'assistant', content: 'Hello' });
      expect(msgs[2]).toEqual({ type: 'assistant', content: ' world' });
      expect(msgs[3].type).toBe('result');
      expect(msgs[3].success).toBe(true);
    });

    it('throws on HTTP error', async () => {
      const upstream = await createMockUpstream(() => ({
        status: 502,
        body: 'Bad gateway',
      }));
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const gen = session.streamToAgent('test');
      await expect(gen.next()).rejects.toThrow('Upstream error 502');
    });
  });

  describe('handleMessage (via onMessage callback)', () => {
    it('forwards inbound message to upstream and delivers response', async () => {
      const upstream = await createMockUpstream((_req, body) => {
        const parsed = JSON.parse(body);
        return {
          status: 200,
          body: JSON.stringify({
            success: true,
            response: `Echo: ${parsed.message}`,
          }),
        };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const adapter = mockAdapter();
      session.registerChannel(adapter);

      // Trigger handleMessage via the onMessage callback
      await adapter.onMessage({
        channel: 'signal',
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'Hello',
        isGroup: false,
      });

      // Should have delivered the response
      expect(adapter.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        text: 'Echo: Hello',
        threadId: undefined,
      });

      // Should have updated tracking
      expect(session.getLastMessageTarget()).toEqual({ channel: 'signal', chatId: 'chat-1' });
      expect(session.getLastUserMessageTime()).toBeInstanceOf(Date);
    });

    it('sends error message to channel on upstream failure', async () => {
      const upstream = await createMockUpstream(() => ({
        status: 500,
        body: 'Server error',
      }));
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const adapter = mockAdapter();
      session.registerChannel(adapter);

      await adapter.onMessage({
        channel: 'signal',
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'Hello',
        isGroup: false,
      });

      // Should have sent the error message
      expect(adapter.sendMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        text: 'Sorry, I encountered an error connecting to the server.',
      });
    });

    it('does not deliver response in listening mode', async () => {
      const upstream = await createMockUpstream(() => ({
        status: 200,
        body: JSON.stringify({ success: true, response: 'noted' }),
      }));
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      const adapter = mockAdapter();
      session.registerChannel(adapter);

      await adapter.onMessage({
        channel: 'signal',
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'Hello',
        isGroup: false,
        isListeningMode: true,
      });

      // Should NOT have sent a response
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('start (health check)', () => {
    it('logs success when upstream is reachable', async () => {
      const upstream = await createMockUpstream((req) => {
        if (req.url === '/api/v1/status') {
          return { status: 200, body: JSON.stringify({ athletes: [] }) };
        }
        return { status: 404, body: '' };
      });
      server = upstream.server;
      session = new EdgeProxySession({ name: 'test', upstreamUrl: upstream.url });

      // Should not throw
      await session.start();
    });

    it('does not throw when upstream is unreachable', async () => {
      session = new EdgeProxySession({ name: 'test', upstreamUrl: 'http://127.0.0.1:1' });
      // Should not throw — just warns
      await session.start();
    });
  });
});
