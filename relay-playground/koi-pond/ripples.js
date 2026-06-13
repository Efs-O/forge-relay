/**
 * Ripples Manager
 * Handles the creation, animation, and rendering of water ripples.
 */
window.Ripples = class Ripples {
  constructor() {
    /** @type {Array<{x: number, y: number, radius: number, opacity: number, speed: number, decay: number}>} */
    this.ripples = [];
  }

  /**
   * Creates a new ripple ring at the specified coordinates.
   * @param {number} x - The x-coordinate of the ripple center.
   * @param {number} y - The y-coordinate of the ripple center.
   */
  spawn(x, y) {
    this.ripples.push({
      x: x,
      y: y,
      radius: 2,
      opacity: 0.8,
      speed: 1.8,
      decay: 0.012
    });
  }

  /**
   * Updates the state of all active ripples.
   * Increases radius and decreases opacity over time.
   */
  update() {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += r.speed;
      r.opacity -= r.decay;

      // Remove ripples that have faded out or grown too large
      if (r.opacity <= 0 || r.radius > 200) {
        this.ripples.splice(i, 1);
      }
    }
  }

  /**
   * Renders all active ripples to the provided 2D context.
   * @param {CanvasRenderingContext2D} ctx - The canvas context to draw on.
   */
  draw(ctx) {
    ctx.save();
    for (let i = 0; i < this.ripples.length; i++) {
      const r = this.ripples[i];
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${r.opacity})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }
};
