import { Logger } from './logger';

const logger = new Logger('MessageQueue');

interface QueuedMessage {
  text: string;
  files?: any[];
  timestamp: number;
  isInterrupt: boolean;
}

export class MessageQueue {
  private queues: Map<string, QueuedMessage[]> = new Map();
  private processing: Set<string> = new Set();

  constructor() {}

  private getQueueKey(channel: string, threadTs: string): string {
    return `${channel}-${threadTs}`;
  }

  enqueue(channel: string, threadTs: string, message: QueuedMessage): void {
    const key = this.getQueueKey(channel, threadTs);

    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }

    const queue = this.queues.get(key)!;

    // If it's an interrupt, clear the queue and add this as the only message
    if (message.isInterrupt) {
      logger.info('Interrupt message received, clearing queue', { key, queueSize: queue.length });
      this.queues.set(key, [message]);
    } else {
      queue.push(message);
      logger.debug('Enqueued message', { key, queueSize: queue.length });
    }
  }

  dequeue(channel: string, threadTs: string): QueuedMessage | null {
    const key = this.getQueueKey(channel, threadTs);
    const queue = this.queues.get(key);

    if (!queue || queue.length === 0) {
      return null;
    }

    const message = queue.shift()!;
    logger.debug('Dequeued message', { key, remainingInQueue: queue.length });
    return message;
  }

  peek(channel: string, threadTs: string): QueuedMessage | null {
    const key = this.getQueueKey(channel, threadTs);
    const queue = this.queues.get(key);

    if (!queue || queue.length === 0) {
      return null;
    }

    return queue[0];
  }

  isProcessing(channel: string, threadTs: string): boolean {
    const key = this.getQueueKey(channel, threadTs);
    return this.processing.has(key);
  }

  setProcessing(channel: string, threadTs: string, processing: boolean): void {
    const key = this.getQueueKey(channel, threadTs);

    if (processing) {
      this.processing.add(key);
      logger.debug('Set processing state', { key, processing: true });
    } else {
      this.processing.delete(key);
      logger.debug('Set processing state', { key, processing: false });
    }
  }

  getQueueSize(channel: string, threadTs: string): number {
    const key = this.getQueueKey(channel, threadTs);
    const queue = this.queues.get(key);
    return queue ? queue.length : 0;
  }

  clearQueue(channel: string, threadTs: string): void {
    const key = this.getQueueKey(channel, threadTs);
    this.queues.delete(key);
    this.processing.delete(key);
    logger.info('Cleared queue', { key });
  }

  hasMessages(channel: string, threadTs: string): boolean {
    return this.getQueueSize(channel, threadTs) > 0;
  }
}

export type { QueuedMessage };
