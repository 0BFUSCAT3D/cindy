import { useCallback, useEffect, useRef, useState } from "react";

/** Newly added images open the card; completing uploads respect an explicit collapse. */
export function useComposerImageExpansion(
  imageCount: number,
  incomingImageCount: number,
) {
  const previousIncomingCount = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // Uploaded and pending lists can briefly overlap; only new incoming slots
    // count as an addition. A paste placeholder becoming an upload keeps its slot.
    if (
      incomingImageCount > previousIncomingCount.current ||
      imageCount === 0
    ) {
      setCollapsed(false);
    }
    previousIncomingCount.current = incomingImageCount;
  }, [imageCount, incomingImageCount]);
  const collapse = useCallback(() => setCollapsed(true), []);
  return { active: imageCount > 0 && !collapsed, collapse };
}
