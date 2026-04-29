import React from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';

const geoUrl = "https://unpkg.com/world-atlas@2.0.2/countries-110m.json";

interface DetectionMapProps {
  checks: any[];
}

export default function DetectionMap({ checks }: DetectionMapProps) {
  // We only want to plot checks that have a location
  const markers = checks.filter(c => c.location);

  return (
    <div className="w-full h-80 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden relative">
      <div className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-sm border border-slate-200 z-10 pointer-events-none">
        <h3 className="text-sm font-semibold text-slate-800">Global Detection Heat Map</h3>
        <p className="text-xs text-slate-500">{markers.length} pinned events</p>
      </div>
      <ComposableMap projection="geoMercator" projectionConfig={{ scale: 120 }}>
        <Geographies geography={geoUrl}>
          {({ geographies }) =>
            geographies.map((geo) => (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                fill="#f1f5f9"
                stroke="#cbd5e1"
                strokeWidth={0.5}
                style={{
                  default: { outline: "none" },
                  hover: { outline: "none", fill: "#e2e8f0" },
                  pressed: { outline: "none" },
                }}
              />
            ))
          }
        </Geographies>
        {markers.map((marker, index) => (
          <Marker key={`${marker.id}-${index}`} coordinates={marker.location}>
            <circle 
              r={marker.alertStatus === 'High-Risk' ? 6 : marker.alertStatus === 'Low-Risk' ? 4 : 3} 
              fill={marker.alertStatus === 'High-Risk' ? "#ef4444" : marker.alertStatus === 'Low-Risk' ? "#f59e0b" : "#3b82f6"} 
              fillOpacity={0.7}
              stroke="#ffffff"
              strokeWidth={1}
            />
          </Marker>
        ))}
      </ComposableMap>
    </div>
  );
}
