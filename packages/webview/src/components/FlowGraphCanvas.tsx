import React, { useEffect, useState, useRef } from 'react';
import { FlowStep } from '@ai-stepflow/core/types';

interface FlowGraphCanvasProps {
  steps: FlowStep[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  isExpanded: boolean;
}

export const FlowGraphCanvas: React.FC<FlowGraphCanvasProps> = ({ steps, containerRef, isExpanded }) => {
  const [paths, setPaths] = useState<{ id: string; d: string }[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const draw = () => {
      if (!containerRef.current || !svgRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newPaths: { id: string; d: string }[] = [];

      steps.forEach(step => {
        const targetEl = document.getElementById(`step-node-${step.id}`);
        if (!targetEl) return;
        const targetRect = targetEl.getBoundingClientRect();

        const targetX = targetRect.left - containerRect.left;
        const targetY = targetRect.top - containerRect.top + targetRect.height / 2;

        (step.dependsOn || []).forEach(depId => {
          const sourceEl = document.getElementById(`step-node-${depId}`);
          if (!sourceEl) return;
          const sourceRect = sourceEl.getBoundingClientRect();

          const sourceX = sourceRect.right - containerRect.left;
          const sourceY = sourceRect.top - containerRect.top + sourceRect.height / 2;

          const cpX1 = sourceX + (targetX - sourceX) / 2;
          const cpX2 = targetX - (targetX - sourceX) / 2;

          const d = `M ${sourceX} ${sourceY} C ${cpX1} ${sourceY}, ${cpX2} ${targetY}, ${targetX} ${targetY}`;
          newPaths.push({ id: `${depId}->${step.id}`, d });
        });
      });

      setPaths(newPaths);
    };

    draw();
    window.addEventListener('resize', draw);
    const observer = new MutationObserver(draw);
    if (containerRef.current) {
      observer.observe(containerRef.current, { childList: true, subtree: true, attributes: true });
    }

    return () => {
      window.removeEventListener('resize', draw);
      observer.disconnect();
    };
  }, [steps, isExpanded, containerRef]);

  return (
    <svg
      ref={svgRef}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0, overflow: 'visible' }}
    >
      <defs>
        <marker id="arrowhead-white" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <polygon points="0 0, 6 3, 0 6" fill="rgba(255,255,255,0.35)" />
        </marker>
        <style>{`
          @keyframes dash-flow {
            from { stroke-dashoffset: 24; }
            to   { stroke-dashoffset: 0; }
          }
          .flow-edge {
            stroke: rgba(255,255,255,0.28);
            stroke-width: 1.5;
            stroke-dasharray: 6 6;
            fill: none;
            animation: dash-flow 1.8s linear infinite;
          }
        `}</style>
      </defs>
      {paths.map(p => (
        <path
          key={p.id}
          className="flow-edge"
          d={p.d}
          markerEnd="url(#arrowhead-white)"
        />
      ))}
    </svg>
  );
};
