import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import { lazy, Suspense } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import OptionsCommandCenter from "./pages/OptionsCommandCenter";

const Home = lazy(() => import("./pages/Home"));
const DashboardV2 = lazy(() => import("./pages/DashboardV2"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const DashboardPro = lazy(() => import("./pages/DashboardPro"));

function Router() {
  return (
    <Switch>
      <Route path="/" component={OptionsCommandCenter} />
      <Route path="/legacy" component={DashboardPro} />
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/v2" component={DashboardV2} />
      <Route path="/v1" component={Dashboard} />
      <Route path="/old" component={Home} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Suspense fallback={<div className="min-h-screen grid place-items-center text-sm text-muted-foreground">Loading…</div>}>
            <Router />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
