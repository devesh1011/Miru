import { suiService } from '../sui/client.js';
import WebSocket from 'ws';
import { config } from '../config/index.js';

export interface SuiEvent {
  id: {
    txDigest: string;
    eventSeq: string;
  };
  packageId: string;
  transactionModule: string;
  sender: string;
  type: string;
  parsedJson: Record<string, any>;
  bcs: string;
  timestampMs: string;
}

/**
 * Event Monitor Service
 * Subscribes to DeepBook events via WebSocket and processes them
 */
export class EventMonitorService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private eventHandlers: Map<string, ((event: SuiEvent) => void)[]> = new Map();

  /**
   * Start monitoring events
   */
  async start() {
    await this.connectWebSocket();
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to specific event type
   */
  onEvent(eventType: string, handler: (event: SuiEvent) => void) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)!.push(handler);
  }

  /**
   * Connect to Sui WebSocket
   */
  private async connectWebSocket() {
    try {
      this.ws = new WebSocket(config.sui.wsUrl);

      this.ws.on('open', () => {
        console.log('✅ WebSocket connected to Sui');
        this.reconnectAttempts = 0;
        this.subscribeToEvents();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });

      this.ws.on('close', () => {
        console.log('WebSocket closed');
        this.attemptReconnect();
      });
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.attemptReconnect();
    }
  }

  /**
   * Subscribe to DeepBook events
   */
  private subscribeToEvents() {
    if (!this.ws) return;

    // Subscribe to all DeepBook package events
    const subscribeMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'suix_subscribeEvent',
      params: [
        {
          Package: config.deepbook.packageId,
        },
      ],
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    console.log('📡 Subscribed to DeepBook events');
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: any) {
    // Handle subscription confirmation
    if (message.result && typeof message.result === 'string') {
      console.log(`Subscription ID: ${message.result}`);
      return;
    }

    // Handle event notification
    if (message.params?.result) {
      const event: SuiEvent = message.params.result;
      this.processEvent(event);
    }
  }

  /**
   * Process a received event
   */
  private processEvent(event: SuiEvent) {
    console.log(`📨 Event received: ${event.type}`);
    
    // Call registered handlers for this event type
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${event.type}:`, error);
        }
      });
    }

    // Call wildcard handlers (if any)
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in wildcard event handler:', error);
        }
      });
    }
  }

  /**
   * Attempt to reconnect WebSocket
   */
  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }
}

// Singleton instance
export const eventMonitorService = new EventMonitorService();
