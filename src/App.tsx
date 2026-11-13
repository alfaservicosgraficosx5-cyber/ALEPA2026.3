import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  FileText,
  GraduationCap,
  Headphones,
  Home,
  Layers,
  LayoutGrid,
  LogOut,
  RotateCcw,
  Sparkles,
  Users,
  Video,
  X,
} from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AuthView } from './components/AuthView';
import { DashboardView } from './components/DashboardView';
import { DisciplinesView } from './components/DisciplinesView';
import { ScheduleView } from './components/ScheduleView';
import { SimuladosView } from './components/SimuladosView';
import { ErrorNotebookView } from './components/ErrorNotebookView';
import { MaterialsView } from './components/MaterialsView';
import { PodcastsView } from './components/PodcastsView';
import { VideosView } from './components/VideosView';
import { GeminiSummaryView, type GeminiTargetPreset } from './components/GeminiSummaryView';
import { PerformanceView } from './components/PerformanceView';
import { FamilyAccessView } from './components/FamilyAccessView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { ShareAppButton } from './components/ShareAppModal';
import { CONCURSO_PROFILE, formatDateKey } from './data/alepaSyllabus';
import { useStudyAlert } from './hooks/useStudyAlert';
import { CampusLevel, LibraryScope, MedioCargoGroup, NavSection } from './types';

function CampusShell() {
  const {
    user,
    isGuest,
    profile,
    authLoading,
    logout,
    exitGuestMode,
    syncError,
    clearSyncError,
    studySessions,
    updateAccessPresenceContext,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<NavSection>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('acesso') === 'familiar') {
        return 'family';
      }
    } catch {
      // ignore query param error
    }
    return 'dashboard';
  });

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('acesso') === 'familiar' && !user && isGuest) {
        exitGuestMode();
      }
    } catch {
      // ignore
    }
  }, [user, isGuest, exitGuestMode]);
  const [selectedCampus, setSelectedCampus] = useState<CampusLevel>(() => {
    try {
      const saved = localStorage.getItem('concurso_alepa_campus');
      return saved === 'medio' || saved === 'superior' ? saved : 'superior';
    } catch {
      return 'superior';
    }
  });
  const [selectedMedioCargo, setSelectedMedioCargo] = useState<MedioCargoGroup>(() => {
    try {
      const saved = localStorage.getItem('concurso_alepa_medio_cargo');
      return saved === 'cargo_01_04' || saved === 'cargo_01' || saved === 'cargo_02' || saved === 'cargo_03'
        ? saved
        : 'cargo_01_04';
    } catch {
      return 'cargo_01_04';
    }
  });
  const [timerPreset, setTimerPreset] = useState<{ disciplineId?: string; topicTitle?: string }>({});
  const [contentInitialScope, setContentInitialScope] = useState<LibraryScope | undefined>(undefined);
  const [geminiPreset, setGeminiPreset] = useState<GeminiTargetPreset | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    updateAccessPresenceContext(activeTab, selectedCampus);
  }, [activeTab, selectedCampus, updateAccessPresenceContext]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  const handleChangeCampus = (campus: CampusLevel) => {
    setSelectedCampus(campus);
    try {
      localStorage.setItem('concurso_alepa_campus', campus);
    } catch {
      // ignore storage errors
    }
  };

  const handleChangeMedioCargo = (group: MedioCargoGroup) => {
    setSelectedMedioCargo(group);
    try {
      localStorage.setItem('concurso_alepa_medio_cargo', group);
    } catch {
      // ignore storage errors
    }
  };

  const todayKey = formatDateKey(new Date());
  const dailyGoal = profile?.dailyGoalMinutes || CONCURSO_PROFILE.dailyGoalMinutes;
  const minutesToday = studySessions
    .filter((s) => s.dateKey === todayKey)
    .reduce((acc, s) => acc + s.durationMinutes, 0);

  const {
    settings: alertSettings,
    updateSettings: updateAlertSettings,
    activeAlertMessage,
    dismissAlert,
    notificationPermission,
    requestNotificationPermission,
    fireStudyAlert,
  } = useStudyAlert(minutesToday, dailyGoal, selectedCampus);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-xl font-bold text-slate-900">Concurso ALEPA 2026</p>
          <p className="text-sm text-slate-500">Carregando área de estudos...</p>
        </div>
      </div>
    );
  }

  if (!user && !isGuest) {
    return <AuthView />;
  }

  const desktopNavItems: Array<{ id: NavSection; label: string }> = [
    { id: 'materials', label: 'Conteúdo' },
    { id: 'disciplines', label: 'Disciplinas' },
    { id: 'videos', label: 'Vídeos' },
    { id: 'gemini', label: 'Gemini IA' },
    { id: 'schedule', label: 'Cronograma' },
    { id: 'simulados', label: 'Simulados' },
    { id: 'revisions', label: 'Revisões' },
    { id: 'podcasts', label: 'Podcasts' },
    { id: 'family', label: 'Familiares' },
  ];

  const primaryMobileTabs: Array<{
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'dashboard', label: 'Início', icon: Home },
    { id: 'materials', label: 'Conteúdo', icon: FileText },
    { id: 'schedule', label: 'Cronograma', icon: CalendarDays },
    { id: 'simulados', label: 'Questões', icon: CheckSquare },
  ];

  const isMoreTabActive =
    activeTab === 'disciplines' ||
    activeTab === 'videos' ||
    activeTab === 'podcasts' ||
    activeTab === 'gemini' ||
    activeTab === 'revisions' ||
    activeTab === 'performance' ||
    activeTab === 'family';

  const mobileSheetItems: Array<{
    id: NavSection;
    label: string;
    subtitle: string;
    icon: React.ComponentType<{ className?: string }>;
    action?: () => void;
  }> = [
    {
      id: 'disciplines',
      label: 'Disciplinas & Edital',
      subtitle: 'Tópicos e prioridades',
      icon: BookOpen,
    },
    {
      id: 'podcasts',
      label: 'Podcasts & Spotify',
      subtitle: 'Áudios por matéria',
      icon: Headphones,
    },
    {
      id: 'videos',
      label: 'Vídeos & Aulas',
      subtitle: 'YouTube, IG e TikTok',
      icon: Video,
    },
    {
      id: 'gemini',
      label: 'Gemini IA',
      subtitle: 'Resumos de vídeo e PDF',
      icon: Sparkles,
    },
    {
      id: 'revisions',
      label: 'Revisões / Erros',
      subtitle: 'Caderno de erros',
      icon: RotateCcw,
    },
    {
      id: 'performance',
      label: 'Desempenho',
      subtitle: 'Evolução e simulados',
      icon: BarChart3,
    },
    {
      id: 'family',
      label: 'Familiares',
      subtitle: 'Acesso compartilhado',
      icon: Users,
    },
  ];

  const activeSectionLabel =
    activeTab === 'disciplines'
      ? 'Disciplinas'
      : activeTab === 'schedule'
        ? 'Cronograma 2h'
        : activeTab === 'simulados'
          ? 'Simulados e Questões'
          : activeTab === 'revisions'
            ? 'Revisões / Erros'
            : activeTab === 'podcasts'
              ? 'Podcasts & Spotify'
              : activeTab === 'videos'
                ? 'Vídeos'
                : activeTab === 'gemini'
                  ? 'Gemini IA'
                  : activeTab === 'materials'
                    ? 'Conteúdo & Biblioteca'
                    : activeTab === 'performance'
                      ? 'Desempenho'
                      : activeTab === 'family'
                        ? 'Familiares'
                        : 'Painel';

  const handleStartFocusTimer = (disciplineId: string, topicTitle: string) => {
    setTimerPreset({ disciplineId, topicTitle });
    setActiveTab('schedule');
  };

  const handleNavigateMobile = (section: NavSection) => {
    setActiveTab(section);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Desktop Top Bar (3-zone Contract) + Compact Mobile Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between gap-2 sm:gap-6">
          <button
            type="button"
            onClick={() => handleNavigateMobile('dashboard')}
            className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 text-left flex items-center gap-2 min-h-[40px]"
          >
            <span className="sm:hidden">ALEPA 2026</span>
            <span className="hidden sm:inline">Concurso ALEPA 2026</span>
            <span className="md:hidden text-[10px] font-mono font-semibold text-[#146C43] bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
              {selectedCampus === 'medio' ? 'Médio' : 'Superior'}
            </span>
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            {desktopNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === item.id
                    ? 'border-[#0B3321] text-slate-900 font-semibold'
                    : 'border-transparent hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            <ShareAppButton variant="header" />
            <PWAInstallButton variant="header" />
            {isGuest && !user && (
              <button
                type="button"
                onClick={exitGuestMode}
                className="min-h-[38px] px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-[#0B3321] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl whitespace-nowrap shrink-0"
              >
                <span className="sm:hidden">Entrar</span>
                <span className="hidden sm:inline">Entrar / Nuvem</span>
              </button>
            )}
            <button
              type="button"
              onClick={logout}
              aria-label="Sair"
              title={`Sair (${profile?.displayName || user?.email || 'Visitante'})`}
              className="min-h-[38px] px-2.5 sm:px-4 py-1.5 text-xs font-semibold text-white bg-[#0B3321] hover:bg-[#134b32] rounded-xl inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3.5 sm:px-6 lg:px-8 py-4 sm:py-8 pb-24 md:pb-12 space-y-5 sm:space-y-6">
        {activeTab !== 'dashboard' && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs text-slate-600">
            <div className="flex items-center justify-between sm:justify-start gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => handleNavigateMobile('dashboard')}
                  className="min-h-[36px] px-2.5 py-1 -ml-1 rounded-lg font-semibold text-[#0B3321] hover:bg-emerald-50 inline-flex items-center gap-1 shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span className="sm:hidden">Início</span>
                  <span className="hidden sm:inline">Painel do Estudante</span>
                </button>
                <span aria-hidden="true" className="text-slate-400">/</span>
                <span className="text-slate-900 font-semibold truncate">{activeSectionLabel}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2 sm:gap-3">
              <div className="grid grid-cols-2 sm:flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-xl w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => handleChangeCampus('superior')}
                  className={`min-h-[34px] px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-colors truncate ${
                    selectedCampus === 'superior' ? 'bg-[#0B3321] text-white' : 'text-slate-700 hover:text-slate-900'
                  }`}
                >
                  Superior (PL.AL.102)
                </button>
                <button
                  type="button"
                  onClick={() => handleChangeCampus('medio')}
                  className={`min-h-[34px] px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-colors truncate ${
                    selectedCampus === 'medio' ? 'bg-[#0B3321] text-white' : 'text-slate-700 hover:text-slate-900'
                  }`}
                >
                  Médio (PL.AL.060)
                </button>
              </div>

              <button
                type="button"
                onClick={() => handleNavigateMobile('performance')}
                className={`hidden sm:inline-flex items-center gap-1.5 font-medium hover:text-slate-900 ${
                  activeTab === 'performance' ? 'text-[#0B3321] underline' : 'text-slate-600'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                <span>Histórico de desempenho</span>
              </button>
            </div>
          </div>
        )}

        {activeAlertMessage && (
          <div
            role="status"
            className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <Bell className="w-5 h-5 text-[#146C43] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-slate-900">Alerta de Estudos · Concurso ALEPA 2026</p>
                <p className="text-xs text-slate-700 mt-0.5">{activeAlertMessage}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  dismissAlert();
                  setActiveTab('schedule');
                }}
                className="min-h-[38px] px-3.5 py-1.5 bg-[#0B3321] text-white text-xs font-semibold rounded-xl"
              >
                Iniciar estudos
              </button>
              <button
                type="button"
                onClick={dismissAlert}
                className="min-h-[38px] px-3 py-1.5 bg-white border border-slate-200 text-slate-700 text-xs font-medium rounded-xl"
              >
                Dispensar
              </button>
            </div>
          </div>
        )}

        {isGuest && !user && (
          <div
            role="status"
            className="bg-slate-100 border border-slate-200 rounded-2xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="text-xs text-slate-700">
              <strong className="text-slate-900">Modo Visitante ativo:</strong> seu progresso, simulados e revisões ficam
              salvos localmente neste navegador sem precisar de e-mail. Para sincronizar entre celular e computador, faça
              login quando quiser.
            </div>
            <button
              type="button"
              onClick={exitGuestMode}
              className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold bg-[#0B3321] hover:bg-[#134b32] text-white rounded-xl whitespace-nowrap shrink-0"
            >
              Fazer login / Salvar na nuvem
            </button>
          </div>
        )}

        {syncError && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 text-red-900 rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-4"
          >
            <span>{syncError}</span>
            <button type="button" onClick={clearSyncError} className="text-xs font-semibold underline">
              Fechar
            </button>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <DashboardView
            campus={selectedCampus}
            onChangeCampus={handleChangeCampus}
            medioCargoGroup={selectedMedioCargo}
            onChangeMedioCargoGroup={handleChangeMedioCargo}
            onNavigate={setActiveTab}
            onOpenContent={(scope) => {
              setContentInitialScope(scope);
              setActiveTab('materials');
            }}
            onStartFocusTimer={handleStartFocusTimer}
            alertSettings={alertSettings}
          />
        )}
        {activeTab === 'disciplines' && (
          <DisciplinesView
            campus={selectedCampus}
            onChangeCampus={handleChangeCampus}
            medioCargoGroup={selectedMedioCargo}
            onChangeMedioCargoGroup={handleChangeMedioCargo}
          />
        )}
        {activeTab === 'schedule' && (
          <ScheduleView
            campus={selectedCampus}
            medioCargoGroup={selectedMedioCargo}
            initialDisciplineId={timerPreset.disciplineId}
            initialTopicTitle={timerPreset.topicTitle}
            alertSettings={alertSettings}
            onUpdateAlertSettings={updateAlertSettings}
            notificationPermission={notificationPermission}
            onRequestNotificationPermission={requestNotificationPermission}
            onTestAlert={() => fireStudyAlert(undefined, true)}
          />
        )}
        {activeTab === 'simulados' && (
          <SimuladosView campus={selectedCampus} medioCargoGroup={selectedMedioCargo} />
        )}
        {activeTab === 'revisions' && <ErrorNotebookView campus={selectedCampus} />}
        {activeTab === 'podcasts' && <PodcastsView campus={selectedCampus} />}
        {activeTab === 'videos' && (
          <VideosView
            campus={selectedCampus}
            onSummarizeWithGemini={(target) => {
              setGeminiPreset(target);
              setActiveTab('gemini');
            }}
          />
        )}
        {activeTab === 'gemini' && (
          <GeminiSummaryView
            campus={selectedCampus}
            presetTarget={geminiPreset}
            onClearPreset={() => setGeminiPreset(null)}
          />
        )}
        {activeTab === 'materials' && (
          <MaterialsView
            campus={selectedCampus}
            initialScope={contentInitialScope}
            onChangeCampus={handleChangeCampus}
            onSummarizeWithGemini={(target) => {
              setGeminiPreset(target);
              setActiveTab('gemini');
            }}
          />
        )}
        {activeTab === 'performance' && (
          <PerformanceView campus={selectedCampus} medioCargoGroup={selectedMedioCargo} />
        )}
        {activeTab === 'family' && (
          <FamilyAccessView
            campus={selectedCampus}
            onNavigate={setActiveTab}
            onOpenContent={(scope) => {
              setContentInitialScope(scope);
              setActiveTab('materials');
            }}
          />
        )}
      </main>

      {/* Mobile Slide-Up Bottom Sheet Menu ("Mais") */}
      {mobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 flex flex-col justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Menu completo mobile"
        >
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setMobileMenuOpen(false)}
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-xs"
          />

          <div className="relative bg-white rounded-t-3xl border-t border-slate-200 shadow-2xl px-4 pt-3 pb-6 pb-safe max-h-[85vh] overflow-y-auto space-y-4">
            <div className="w-10 h-1.5 rounded-full bg-slate-300 mx-auto" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold text-[#146C43]">Navegação Rápida</p>
                <h2 className="font-display text-lg font-bold text-slate-900">Mais ferramentas de estudo</h2>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Fechar"
                className="min-w-[40px] min-h-[40px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Campus Switcher inside Drawer */}
            <div className="p-2.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
              <p className="text-[11px] font-semibold text-slate-600 px-1">Campus ativo no celular:</p>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => handleChangeCampus('superior')}
                  className={`min-h-[44px] px-3 py-2 rounded-xl text-left text-xs font-semibold transition-colors flex items-center gap-2 ${
                    selectedCampus === 'superior'
                      ? 'bg-[#0B3321] text-white'
                      : 'bg-white border border-slate-200 text-slate-800'
                  }`}
                >
                  <GraduationCap className="w-4 h-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate">Nível Superior</p>
                    <p className={`text-[10px] font-mono ${selectedCampus === 'superior' ? 'text-emerald-200' : 'text-slate-500'}`}>
                      PL.AL.102
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleChangeCampus('medio')}
                  className={`min-h-[44px] px-3 py-2 rounded-xl text-left text-xs font-semibold transition-colors flex items-center gap-2 ${
                    selectedCampus === 'medio'
                      ? 'bg-[#0B3321] text-white'
                      : 'bg-white border border-slate-200 text-slate-800'
                  }`}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate">Nível Médio</p>
                    <p className={`text-[10px] font-mono ${selectedCampus === 'medio' ? 'text-emerald-200' : 'text-slate-500'}`}>
                      PL.AL.060
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {/* All remaining sections as thumb-friendly tiles */}
            <div className="grid grid-cols-2 gap-2.5">
              {mobileSheetItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigateMobile(item.id)}
                    className={`min-h-[58px] p-3 rounded-2xl border text-left transition-transform active:scale-[0.98] flex items-start gap-2.5 ${
                      active
                        ? 'border-[#0B3321] bg-emerald-50/70 text-[#0B3321]'
                        : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-900'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        active ? 'bg-[#0B3321] text-white' : 'bg-emerald-50 text-[#146C43]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold truncate">{item.label}</p>
                      <p className="text-[11px] text-slate-500 truncate mt-0.5">{item.subtitle}</p>
                    </div>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  setContentInitialScope('geral');
                  handleNavigateMobile('materials');
                }}
                className="min-h-[58px] p-3 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-left transition-transform active:scale-[0.98] flex items-start gap-2.5"
              >
                <div className="w-8 h-8 rounded-xl bg-emerald-50 text-[#146C43] flex items-center justify-center shrink-0">
                  <ChevronRight className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-900 truncate">Aba Geral</p>
                  <p className="text-[11px] text-slate-500 truncate mt-0.5">Matérias comuns</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Tab Bar (5 ergonomic evenly distributed tabs in thumb zone) */}
      <nav
        aria-label="Navegação mobile"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-5 items-center h-16 pb-safe"
      >
        {primaryMobileTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleNavigateMobile(tab.id)}
              className={`relative flex flex-col items-center justify-center min-h-[48px] px-1 transition-transform active:scale-95 ${
                isActive ? 'text-[#0B3321] font-semibold' : 'text-slate-500'
              }`}
            >
              {isActive && <span className="absolute top-0 w-7 h-0.5 rounded-full bg-[#0B3321]" />}
              <Icon className="w-5 h-5" />
              <span className="text-[11px] tracking-tight mt-1 whitespace-nowrap">{tab.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          aria-expanded={mobileMenuOpen}
          className={`relative flex flex-col items-center justify-center min-h-[48px] px-1 transition-transform active:scale-95 ${
            mobileMenuOpen || isMoreTabActive ? 'text-[#0B3321] font-semibold' : 'text-slate-500'
          }`}
        >
          {(mobileMenuOpen || isMoreTabActive) && (
            <span className="absolute top-0 w-7 h-0.5 rounded-full bg-[#0B3321]" />
          )}
          <LayoutGrid className="w-5 h-5" />
          <span className="text-[11px] tracking-tight mt-1 whitespace-nowrap">Mais</span>
        </button>
      </nav>
      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <CampusShell />
    </AuthProvider>
  );
}
