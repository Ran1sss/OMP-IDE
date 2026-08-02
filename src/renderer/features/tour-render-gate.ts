export class TourRenderGate {
  private rendering = false;

  tryNavigate(navigate: () => void): boolean {
    if (this.rendering) return false;
    this.rendering = true;
    navigate();
    return true;
  }

  settle(): void {
    this.rendering = false;
  }
}
