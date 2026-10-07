'use client';

/**
 * Shared math-aware text rendering (extracted from the quiz view so the
 * mistake book renders the same LaTeX-capable question/analysis text instead
 * of raw `$...$` strings — R11).
 */
import { memo, useMemo } from 'react';

import { renderQuizMathText } from '@/lib/quiz/math-text';
import { cn } from '@/lib/utils';

export const MathText = memo(function MathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});
