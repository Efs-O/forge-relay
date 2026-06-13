window.KoiFish = class KoiFish {
  constructor(canvasWidth, canvasHeight) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    // Random initial position
    this.x = Math.random() * (canvasWidth - 60) + 30;
    this.y = Math.random() * (canvasHeight - 60) + 30;

    // Movement properties
    this.speed = 1.2 + Math.random() * 2.5;
    this.angle = Math.random() * Math.PI * 2;
    
    // Visual properties
    this.size = 15 + Math.random() * 15;
    this.tailWiggle = 0;
    this.color = `hsl(${Math.random() * 360}, 70%, 60%)`;
  }

  update() {
    // Wander logic: slightly change angle randomly
    this.angle += (Math.random() - 0.5) * 0.1;

    // Update position based on angle and speed
    this.x += Math.cos(this.angle) * this.speed;
    this.y += Math.sin(this.angle) * this.speed;

    // Keep within bounds with a margin
    const margin = 50;
    if (this.x < margin) {
      this.x = margin;
      this.angle = Math.PI * 0.8;
    } else if (this.x > this.canvasWidth - margin) {
      this.x = this.canvasWidth - margin;
      this.angle = -Math.PI * 0.2;
    }

    if (this.y < margin) {
      this.y = margin;
      this.angle = Math.PI * 0.2;
    } else if (this.y > this.canvasHeight - margin) {
      this.y = this.canvasHeight - margin;
      this.angle = -Math.PI * 0.8;
    }

    // Tail wiggle tied to movement speed and time
    const time = Date.now();
    this.tailWiggle = Math.sin(time * 0.01 * (this.speed * 0.8)) * 10;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    // Draw body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, this.size, this.size * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw tail
    ctx.beginPath();
    ctx.moveTo(-this.size * 0.8, 0);
    ctx.lineTo(-this.size * 1.5, -this.size * 0.5 + this.tailWiggle);
    ctx.lineTo(-this.size * 1.5, this.size * 0.5 + this.tailWiggle);
    ctx.closePath();
    ctx.fill();

    // Draw eye
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(this.size * 0.6, -this.size * 0.2, this.size * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(this.size * 0.7, -this.size * 0.2, this.size * 0.07, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
};
