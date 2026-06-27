import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "@/layouts/AppLayout";
import Dashboard from "@/pages/Dashboard";
import ImageGen from "@/pages/ImageGen";
import VideoGen from "@/pages/VideoGen";
import Workbench from "@/pages/Workbench";
import Matte from "@/pages/Matte";
import SpriteSplit from "@/pages/SpriteSplit";
import ImageTools from "@/pages/ImageTools";
import History from "@/pages/History";
import Assets from "@/pages/Assets";
import Settings from "@/pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="image-gen" element={<ImageGen />} />
        <Route path="video-gen" element={<VideoGen />} />
        <Route path="workbench" element={<Workbench />} />
        <Route path="matte" element={<Matte />} />
        <Route path="sprite-split" element={<SpriteSplit />} />
        <Route path="image-tools" element={<ImageTools />} />
        <Route path="history" element={<History />} />
        <Route path="assets" element={<Assets />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
