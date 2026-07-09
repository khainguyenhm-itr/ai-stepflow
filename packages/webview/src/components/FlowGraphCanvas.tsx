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
      const root = containerRef.current;
      if (!root || !svgRef.current) return;
      const containerRect = root.getBoundingClientRect();
      const newPaths: { id: string; d: string }[] = [];

      // Scope node lookups to THIS flow's canvas. Step ids are only unique within a flow, so a
      // document-wide getElementById would resolve to a same-id node in another flow's board
      // (drawing edges that shoot off toward the wrong flow).
      const findNode = (stepId: string) => root.querySelector(`[id="step-node-${stepId}"]`);

      steps.forEach(step => {
        const targetEl = findNode(step.id);
        if (!targetEl) return;
        const targetRect = targetEl.getBoundingClientRect();

        const targetX = targetRect.left - containerRect.left;
        const targetY = targetRect.top - containerRect.top + targetRect.height / 2;

        (step.dependsOn || []).forEach(depId => {
          const sourceEl = findNode(depId);
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
    <svg ref={svgRef} className="edges">
      {paths.map(p => (
        <path key={p.id} className="flow-edge" d={p.d} />
      ))}
    </svg>
  );
};
