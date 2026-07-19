import {
  createContext,
  useContext,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";

const ZoomInvariantScaleContext = createContext(1);

function normalizeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

interface ZoomInvariantScaleProviderProps {
  children: ReactNode;
  scale: number;
}

/**
 * Keeps portaled descendants in the same visual coordinate system as a
 * zoom-invariant region. React context crosses portal boundaries, which lets
 * overlays compensate without coupling them to the window-frame component.
 */
export function ZoomInvariantScaleProvider({
  children,
  scale,
}: ZoomInvariantScaleProviderProps) {
  return (
    <ZoomInvariantScaleContext.Provider value={normalizeScale(scale)}>
      {children}
    </ZoomInvariantScaleContext.Provider>
  );
}

export function useZoomInvariantScale(): number {
  return useContext(ZoomInvariantScaleContext);
}

type ZoomInvariantFlowRegionProps = ComponentPropsWithoutRef<"div"> & {
  enabled: boolean;
  regionHeight: CSSProperties["height"];
};

type ZoomInvariantRegionStyle = CSSProperties & {
  "--zoom-invariant-region-height": CSSProperties["height"];
};

/**
 * Reserves the zoom-compensated flow height while counter-scaling its visual
 * contents. This is used for chrome that lives inside otherwise zoomable UI,
 * such as the toolbar at the top of the sidebar.
 */
export function ZoomInvariantFlowRegion({
  enabled,
  regionHeight,
  className,
  ...contentProps
}: ZoomInvariantFlowRegionProps) {
  if (!enabled) {
    return <div className={className} {...contentProps} />;
  }

  const slotStyle: ZoomInvariantRegionStyle = {
    "--zoom-invariant-region-height": regionHeight,
  };

  return (
    <div className="zoom-invariant-flow-slot" style={slotStyle}>
      <div
        className={`${className ?? ""} zoom-invariant-flow-content`.trim()}
        {...contentProps}
      />
    </div>
  );
}
