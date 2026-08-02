export class SearchResultState {
  done = false;
  stale = false;
  failed = false;

  get canReplace(): boolean {
    return this.done && !this.stale && !this.failed;
  }

  startSearch(): void {
    this.done = false;
    this.stale = false;
    this.failed = false;
  }

  complete(failed = false): void {
    this.done = true;
    this.failed = failed;
  }

  markStale(): void {
    if (this.done) this.stale = true;
  }


  reset(): void {
    this.done = false;
    this.stale = false;
    this.failed = false;
  }
}
