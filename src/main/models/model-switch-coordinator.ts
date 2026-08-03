export interface CoordinatedModelSwitch {
  id: string;
  selector: string;
  origin: string;
}

/** FIFO serialization and immutable correlation for canonical model switches. */
export class ModelSwitchCoordinator {
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly idleQueue: CoordinatedModelSwitch[] = [];
  private readonly activeQueue: CoordinatedModelSwitch[] = [];

  create(selector: string, origin: string): CoordinatedModelSwitch {
    return { id: `switch_${++this.sequence}`, selector, origin };
  }

  run<T>(request: CoordinatedModelSwitch, operation: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    this.activeQueue.push(request);
    const result = prior.then(operation, operation).finally(() => {
      const index = this.activeQueue.findIndex((candidate) => candidate.id === request.id);
      if (index >= 0) this.activeQueue.splice(index, 1);
    });
    const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    this.tail = result.then(yieldTurn, yieldTurn);
    return result;
  }

  waitForIdle(request: CoordinatedModelSwitch): void {
    this.idleQueue.push(request);
  }

  firstIdle(): CoordinatedModelSwitch | null {
    return this.idleQueue[0] ?? null;
  }

  firstPending(): CoordinatedModelSwitch | null {
    return this.activeQueue[0] ?? this.idleQueue[0] ?? null;
  }

  takeIdle(): CoordinatedModelSwitch[] {
    return this.idleQueue.splice(0);
  }
}
