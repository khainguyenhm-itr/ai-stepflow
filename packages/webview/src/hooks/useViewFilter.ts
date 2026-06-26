import { useState, useEffect, useCallback } from 'react';
import { ViewFilter } from '../components/ScopeControls';

export function useViewFilter(
  initialValue: ViewFilter,
  onPersist: (value: ViewFilter) => void
): [ViewFilter, (v: ViewFilter) => void] {
  const [filter, setFilter] = useState<ViewFilter>(initialValue);

  useEffect(() => {
    setFilter(initialValue);
  }, [initialValue]);

  const setFilterAndPersist = useCallback((value: ViewFilter) => {
    setFilter(value);
    onPersist(value);
  }, [onPersist]);

  return [filter, setFilterAndPersist];
}
