import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "@/layouts/AppLayout";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const ImageGen = lazy(() => import("@/pages/ImageGen"));
const VideoGen = lazy(() => import("@/pages/VideoGen"));
const Workbench = lazy(() => import("@/pages/Workbench"));
const Matte = lazy(() => import("@/pages/Matte"));
const SpriteSplit = lazy(() => import("@/pages/SpriteSplit"));
const ImageTools = lazy(() => import("@/pages/ImageTools"));
const History = lazy(() => import("@/pages/History"));
const Assets = lazy(() => import("@/pages/Assets"));
const Settings = lazy(() => import("@/pages/Settings"));

function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-label="页面加载中">
      <span className="route-fallback-mark" aria-hidden />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Suspense fallback={<RouteFallback />}><Dashboard /></Suspense>} />
        <Route path="image-gen" element={<Suspense fallback={<RouteFallback />}><ImageGen /></Suspense>} />
        <Route path="video-gen" element={<Suspense fallback={<RouteFallback />}><VideoGen /></Suspense>} />
        <Route path="workbench" element={<Suspense fallback={<RouteFallback />}><Workbench /></Suspense>} />
        <Route path="matte" element={<Suspense fallback={<RouteFallback />}><Matte /></Suspense>} />
        <Route path="sprite-split" element={<Suspense fallback={<RouteFallback />}><SpriteSplit /></Suspense>} />
        <Route path="image-tools" element={<Suspense fallback={<RouteFallback />}><ImageTools /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<RouteFallback />}><History /></Suspense>} />
        <Route path="assets" element={<Suspense fallback={<RouteFallback />}><Assets /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
