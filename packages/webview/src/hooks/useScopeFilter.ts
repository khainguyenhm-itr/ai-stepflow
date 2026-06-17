import { useState, useEffect, useCallback } from 'react';
import { ScopeFilter } from '../components/ScopeControls';

export function useScopeFilter(
  initialValue: ScopeFilter,
  onPersist: (value: ScopeFilter) => void
): [ScopeFilter, (v: ScopeFilter) => void] {
  const [filter, setFilter] = useState<ScopeFilter>(initialValue);

  useEffect(() => {
    setFilter(initialValue);
  }, [initialValue]);

  const setFilterAndPersist = useCallback((value: ScopeFilter) => {
    setFilter(value);
    onPersist(value);
  }, [onPersist]);

  return [filter, setFilterAndPersist];
}
