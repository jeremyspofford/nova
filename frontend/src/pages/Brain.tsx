import { useEffect, useRef, useState } from 'react';
import { ChatPanel } from '../chat/ChatPanel';

export function Brain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chatOpen, setChatOpen] = useState(true);

  useEffect(() => {
    // Placeholder: for Phase 1, just render empty canvas
    // Will wire in actual memory graph rendering in Phase 2
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth - (chatOpen ? 350 : 0);
    canvas.height = window.innerHeight;

    // Draw simple background gradient
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#0C0A09');
    gradient.addColorStop(1, '#1C1917');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw placeholder text
    ctx.fillStyle = '#19A89E';
    ctx.font = '48px Plus Jakarta Sans';
    ctx.textAlign = 'center';
    ctx.fillText('Brain Graph', canvas.width / 2, canvas.height / 2 - 50);

    ctx.fillStyle = '#78716C';
    ctx.font = '16px Plus Jakarta Sans';
    ctx.fillText('Memory nodes will appear here in Phase 2', canvas.width / 2, canvas.height / 2 + 30);

    // Handle window resize
    const handleResize = () => {
      canvas.width = window.innerWidth - (chatOpen ? 350 : 0);
      canvas.height = window.innerHeight;
      // Redraw on resize
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [chatOpen]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-stone-950">
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* HUD buttons */}
      <div className="absolute top-4 left-4 z-10 flex gap-2">
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded text-sm transition"
        >
          {chatOpen ? 'Hide Chat' : 'Show Chat'}
        </button>
      </div>

      {/* Always-open chat panel */}
      {chatOpen && <ChatPanel />}
    </div>
  );
}
