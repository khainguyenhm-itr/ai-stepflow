import { useState, useEffect, useCallback } from 'react';
import { SortOrder } from '../components/ScopeControls';

export function useSortOrder(
  initialValue: SortOrder,
  onPersist: (value: SortOrder) => void
): [SortOrder, (v: SortOrder) => void] {
  const [order, setOrder] = useState<SortOrder>(initialValue);

  useEffect(() => {
    setOrder(initialValue);
  }, [initialValue]);

  const setOrderAndPersist = useCallback((value: SortOrder) => {
    setOrder(value);
    onPersist(value);
  }, [onPersist]);

  return [order, setOrderAndPersist];
}
