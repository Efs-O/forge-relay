(function () {
    // Create canvas and append to body
    const canvas = document.createElement('canvas');
    canvas.id = 'pond';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // Set canvas to fullscreen and handle resize
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // Instantiate Ripples (singleton)
    const ripples = new Ripples();

    // Instantiate KoiFish array
    const fishCount = 8;
    const fishArray = [];
    for (let i = 0; i < fishCount; i++) {
        fishArray.push(new KoiFish(canvas.width, canvas.height));
    }

    // Draw static lily pads
    function drawLilyPads() {
        ctx.fillStyle = 'rgba(0, 100, 0, 0.3)';
        // Draw a few lily pads at fixed positions
        const lilyPads = [
            { x: 100, y: 100 },
            { x: 300, y: 200 },
            { x: 500, y: 150 },
            { x: 200, y: 400 },
            { x: 600, y: 350 }
        ];
        lilyPads.forEach(pad => {
            ctx.beginPath();
            ctx.arc(pad.x, pad.y, 20, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // Event listener for pointerdown/mousedown
    canvas.addEventListener('pointerdown', (e) => {
        ripples.spawn(e.clientX, e.clientY);
    });
    canvas.addEventListener('mousedown', (e) => {
        ripples.spawn(e.clientX, e.clientY);
    });

    // Main animation loop
    function loop() {
        // 1. Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 2. Draw lily pads
        drawLilyPads();

        // 3. Update and draw ripples
        ripples.update();
        ripples.draw(ctx);

        // 4. Update and draw fish
        fishArray.forEach(fish => {
            fish.update();
            fish.draw(ctx);
        });

        // Request next frame
        requestAnimationFrame(loop);
    }

    // Start the loop
    requestAnimationFrame(loop);
})();