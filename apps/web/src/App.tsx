import { Navigate, Route, Routes } from 'react-router-dom';
import { Activity } from './pages/Activity';
import { Announcements } from './pages/Announcements';
import { Composer } from './pages/Composer';
import { Detail } from './pages/Detail';
import { Landing, Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { PublicDetail, PublicFeed } from './pages/Public';
import { PublicConfirm, PublicMailbox, PublicUnsubscribe } from './pages/PublicFollow';
import { Publishing } from './pages/Publishing';
import { ReviewInbox, ReviewRoom } from './pages/Review';
import { Workspace } from './pages/Workspace';
import { RequireSession } from './shell';
import { SessionProvider } from './session';
import { ToastProvider } from './ui';

export function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />

          <Route path="/app" element={<RequireSession />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="announcements" element={<Announcements />} />
            <Route path="announcements/new" element={<Composer />} />
            <Route path="announcements/:id" element={<Detail />} />
            <Route path="announcements/:id/edit" element={<Composer />} />
            <Route path="announcements/:id/review" element={<ReviewRoom />} />
            <Route path="review" element={<ReviewInbox />} />
            <Route path="publishing" element={<Publishing />} />
            <Route path="activity" element={<Activity />} />
            <Route path="workspace" element={<Workspace />} />
          </Route>

          <Route path="/public/announcements" element={<PublicFeed />} />
          <Route path="/public/announcements/:id" element={<PublicDetail />} />
          <Route path="/public/confirm" element={<PublicConfirm />} />
          <Route path="/public/unsubscribe" element={<PublicUnsubscribe />} />
          <Route path="/public/mailbox" element={<PublicMailbox />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </ToastProvider>
  );
}
