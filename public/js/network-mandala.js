// Generate SVG for complex network mandala
function generateNetworkMandala() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  // Define nodes in concentric circles
  const nodes = [];
  const circles = [
    { radius: 95, count: 12 },   // Outer circle
    { radius: 70, count: 12 },   // Mid-outer circle
    { radius: 50, count: 8 },    // Mid circle
    { radius: 30, count: 6 },    // Inner circle
    { radius: 0, count: 1 }      // Center
  ];

  let nodeId = 0;
  circles.forEach(circle => {
    for (let i = 0; i < circle.count; i++) {
      const angle = (i / circle.count) * Math.PI * 2;
      const x = 100 + circle.radius * Math.cos(angle);
      const y = 100 + circle.radius * Math.sin(angle);
      nodes.push({ id: nodeId++, x, y, radius: circle.radius });
    }
  });

  // Draw connections between nearby nodes
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('stroke', 'currentColor');
  g.setAttribute('stroke-width', '1.5');
  g.setAttribute('fill', 'none');

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Connect nodes within certain distance
      if (dist < 45 && dist > 0) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', nodes[i].x);
        line.setAttribute('y1', nodes[i].y);
        line.setAttribute('x2', nodes[j].x);
        line.setAttribute('y2', nodes[j].y);
        line.setAttribute('opacity', '0.6');
        g.appendChild(line);
      }
    }
  }

  svg.appendChild(g);

  // Draw circles (nodes)
  nodes.forEach(node => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', node.x);
    circle.setAttribute('cy', node.y);
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', 'currentColor');
    svg.appendChild(circle);
  });

  return svg.outerHTML;
}

// Export as data URI for CSS
window.networkMandalaDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(generateNetworkMandala())}`;
