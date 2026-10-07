'use client';

import { cn } from '@/lib/utils';

export type DifficultyPreference = 'easy' | 'medium' | 'hard';

interface DifficultyPickerProps {
  value: DifficultyPreference | null;
  labels: { auto: string; easy: string; medium: string; hard: string };
  onChange: (value: DifficultyPreference | null) => void;
  disabled?: boolean;
}

/**
 * Quiz difficulty preference for course generation. `null` keeps the legacy
 * behavior: the outline model infers difficulty from the requirement text.
 */
export function DifficultyPicker({ value, labels, onChange, disabled }: DifficultyPickerProps) {
  const options: Array<{ key: DifficultyPreference | null; label: string }> = [
    { key: null, label: labels.auto },
    { key: 'easy', label: labels.easy },
    { key: 'medium', label: labels.medium },
    { key: 'hard', label: labels.hard },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="quiz difficulty"
      className={cn(
        'inline-flex h-8 shrink-0 select-none items-center gap-0.5 rounded-full border border-border/70 bg-muted/40 p-0.5',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.key)}
            className={cn(
              'h-7 cursor-pointer rounded-full px-2.5 text-xs font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
