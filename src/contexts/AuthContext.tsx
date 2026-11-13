import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  OperationType,
  auth,
  db,
  googleAuthProvider,
  handleFirestoreError,
  isAdminEmail,
  testFirestoreConnection,
  toFamilyMemberDocId,
  workspaceAuthProvider,
} from '../lib/firebase';
import { CONCURSO_PROFILE } from '../data/alepaSyllabus';
import { CETAP_QUESTIONS, DEFAULT_STUDY_MATERIALS } from '../data/alepaQuestions';
import { EXTRA_CURATED_QUESTIONS } from '../data/alepaExtraQuestions';
import { GERAL_DEFAULT_MATERIALS } from '../data/alepaGeneralLibrary';
import { MEDIO_DEFAULT_MATERIALS, MEDIO_QUESTIONS } from '../data/alepaMedioLibrary';
import {
  AccessSession,
  BlockType,
  CampusLevel,
  DisciplineWeeklyGoal,
  ErrorEntry,
  ErrorReason,
  FamilyMember,
  LibraryCategoryId,
  LinkStatus,
  MaterialFileType,
  Question,
  QuestionOriginType,
  ResourceType,
  SimuladoAttempt,
  StudyMaterial,
  StudySession,
  TopicProgress,
  UserProfile,
  UserRole,
} from '../types';

interface AuthContextValue {
  user: User | null;
  isGuest: boolean;
  profile: UserProfile | null;
  authLoading: boolean;
  syncError: string | null;
  clearSyncError: () => void;
  workspaceAccessToken: string | null;
  connectGoogleWorkspace: () => Promise<string | null>;
  clearWorkspaceToken: () => void;
  isAdmin: boolean;
  canPublishShared: boolean;
  myFamilyMembership: FamilyMember | null;
  familyMembers: FamilyMember[];
  accessSessions: AccessSession[];
  updateAccessPresenceContext: (tab: string, campus: CampusLevel) => void;
  inviteFamilyMember: (input: {
    name: string;
    email: string;
    relationship: string;
    canPublish: boolean;
  }) => Promise<void>;
  toggleFamilyMemberPublish: (memberId: string, canPublish: boolean) => Promise<void>;
  toggleFamilyMemberActive: (memberId: string, active: boolean) => Promise<void>;
  removeFamilyMember: (memberId: string) => Promise<void>;
  topicProgressMap: Record<string, TopicProgress>;
  disciplineGoalsMap: Record<string, DisciplineWeeklyGoal>;
  studySessions: StudySession[];
  simuladoAttempts: SimuladoAttempt[];
  errorNotebook: ErrorEntry[];
  materials: StudyMaterial[];
  questions: Question[];
  loginWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string, displayName: string, preferredRole: UserRole) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  enterGuestMode: () => void;
  exitGuestMode: () => void;
  resendVerification: () => Promise<void>;
  refreshAuthState: () => Promise<void>;
  logout: () => Promise<void>;
  updateProfileSettings: (patch: { displayName?: string; dailyGoalMinutes?: number }) => Promise<void>;
  saveDisciplineWeeklyGoal: (disciplineId: string, weeklyGoalMinutes: number) => Promise<void>;
  saveTopicProgress: (
    topicId: string,
    disciplineId: string,
    patch: Partial<Pick<TopicProgress, 'theoryDone' | 'questionsDone' | 'revisionDone' | 'notes'>>
  ) => Promise<void>;
  logStudySession: (input: {
    dateKey: string;
    disciplineId: string;
    topicTitle: string;
    blockType: BlockType;
    durationMinutes: number;
    notes?: string;
  }) => Promise<void>;
  saveSimuladoAttempt: (input: {
    title: string;
    mode: 'treino' | 'simulado';
    primaryDisciplineId: string;
    totalQuestions: number;
    correctCount: number;
    score: number;
    durationSeconds: number;
  }) => Promise<void>;
  addErrorEntry: (input: {
    questionId: string;
    disciplineId: string;
    topicTitle: string;
    questionStem: string;
    correctOption: string;
    selectedOption: string;
    errorReason: ErrorReason;
    improvementNote: string;
  }) => Promise<void>;
  updateErrorEntry: (
    entryId: string,
    patch: Partial<Pick<ErrorEntry, 'errorReason' | 'improvementNote' | 'nextReviewDate' | 'reviewCount' | 'status'>>
  ) => Promise<void>;
  deleteErrorEntry: (entryId: string) => Promise<void>;
  addMaterial: (input: {
    title: string;
    disciplineId: string;
    libraryCategoryId?: LibraryCategoryId;
    editalTopic?: string;
    resourceType?: ResourceType;
    fileType: MaterialFileType;
    institution?: string;
    url: string;
    pricing?: 'gratuito' | 'pago';
    publishedAt?: string;
    lastVerifiedAt?: string;
    linkStatus?: LinkStatus;
    isOfficialContent?: boolean;
    fileName?: string;
    description?: string;
    isShared?: boolean;
  }) => Promise<void>;
  deleteMaterial: (materialId: string) => Promise<void>;
  addCustomQuestion: (input: {
    disciplineId: string;
    topicTitle: string;
    statement: string;
    options: [string, string, string, string, string];
    correctIndex: number;
    explanation: string;
    legalBasis?: string;
    source?: string;
    originType?: QuestionOriginType;
    isOfficial?: boolean;
    isPublished?: boolean;
  }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || `id_${Date.now()}`;
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const GUEST_MODE_KEY = 'concurso_alepa_guest_mode';
const GUEST_DATA_KEY = 'concurso_alepa_guest_data_v1';
const DEVICE_ID_KEY = 'concurso_alepa_device_id_v1';
const GUEST_UID = 'guest_local';

function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[a-zA-Z0-9_-]{4,80}$/.test(existing)) {
      return existing;
    }
    const created = sanitizeId(`dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 80);
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return 'dev_browser';
  }
}

function detectDeviceType(): 'mobile' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

interface GuestStoreData {
  profile: UserProfile;
  topicProgressMap: Record<string, TopicProgress>;
  disciplineGoalsMap: Record<string, DisciplineWeeklyGoal>;
  studySessions: StudySession[];
  simuladoAttempts: SimuladoAttempt[];
  errorNotebook: ErrorEntry[];
  myMaterials: StudyMaterial[];
  myQuestions: Question[];
}

function createDefaultGuestProfile(): UserProfile {
  return {
    uid: GUEST_UID,
    displayName: 'Visitante ALEPA',
    role: 'student',
    dailyGoalMinutes: CONCURSO_PROFILE.dailyGoalMinutes,
    examDate: CONCURSO_PROFILE.examDate,
    targetCargo: 'Cargo 03 – Técnico Legislativo (PL.AL.102)',
  };
}

function loadGuestStore(): GuestStoreData {
  const fallback: GuestStoreData = {
    profile: createDefaultGuestProfile(),
    topicProgressMap: {},
    disciplineGoalsMap: {},
    studySessions: [],
    simuladoAttempts: [],
    errorNotebook: [],
    myMaterials: [],
    myQuestions: [],
  };
  try {
    const raw = localStorage.getItem(GUEST_DATA_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<GuestStoreData>;
    return {
      profile: parsed.profile ? { ...createDefaultGuestProfile(), ...parsed.profile, uid: GUEST_UID } : fallback.profile,
      topicProgressMap: parsed.topicProgressMap || {},
      disciplineGoalsMap: parsed.disciplineGoalsMap || {},
      studySessions: Array.isArray(parsed.studySessions) ? parsed.studySessions : [],
      simuladoAttempts: Array.isArray(parsed.simuladoAttempts) ? parsed.simuladoAttempts : [],
      errorNotebook: Array.isArray(parsed.errorNotebook) ? parsed.errorNotebook : [],
      myMaterials: Array.isArray(parsed.myMaterials) ? parsed.myMaterials : [],
      myQuestions: Array.isArray(parsed.myQuestions) ? parsed.myQuestions : [],
    };
  } catch {
    return fallback;
  }
}

function saveGuestStore(data: GuestStoreData): void {
  try {
    localStorage.setItem(GUEST_DATA_KEY, JSON.stringify(data));
  } catch {
    // ignore storage quota errors
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isGuest, setIsGuest] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GUEST_MODE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [, setAuthRefreshTick] = useState(0);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  // In-memory only (never localStorage/sessionStorage) per Workspace security rules
  const [workspaceAccessToken, setWorkspaceAccessToken] = useState<string | null>(null);

  const [topicProgressMap, setTopicProgressMap] = useState<Record<string, TopicProgress>>({});
  const [disciplineGoalsMap, setDisciplineGoalsMap] = useState<Record<string, DisciplineWeeklyGoal>>({});
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [simuladoAttempts, setSimuladoAttempts] = useState<SimuladoAttempt[]>([]);
  const [errorNotebook, setErrorNotebook] = useState<ErrorEntry[]>([]);
  const [sharedMaterials, setSharedMaterials] = useState<StudyMaterial[]>([]);
  const [myMaterials, setMyMaterials] = useState<StudyMaterial[]>([]);
  const [publishedQuestions, setPublishedQuestions] = useState<Question[]>([]);
  const [myQuestions, setMyQuestions] = useState<Question[]>([]);
  const [myFamilyMembership, setMyFamilyMembership] = useState<FamilyMember | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [accessSessions, setAccessSessions] = useState<AccessSession[]>([]);
  const presenceContextRef = useRef<{ tab: string; campus: CampusLevel }>({
    tab: 'dashboard',
    campus: 'superior',
  });
  const deviceIdRef = useRef<string>(getOrCreateDeviceId());

  const isAdmin = Boolean(user?.emailVerified && isAdminEmail(user?.email));
  const canPublishShared =
    isAdmin || Boolean(user?.emailVerified && myFamilyMembership?.active && myFamilyMembership?.canPublish);

  useEffect(() => {
    void testFirestoreConnection();
  }, []);

  const hydrateGuestData = () => {
    const data = loadGuestStore();
    setProfile(data.profile);
    setTopicProgressMap(data.topicProgressMap);
    setDisciplineGoalsMap(data.disciplineGoalsMap);
    setStudySessions(data.studySessions);
    setSimuladoAttempts(data.simuladoAttempts);
    setErrorNotebook(data.errorNotebook);
    setMyMaterials(data.myMaterials);
    setMyQuestions(data.myQuestions);
  };

  const persistGuestPatch = (updater: (prev: GuestStoreData) => GuestStoreData) => {
    const current = loadGuestStore();
    const next = updater(current);
    saveGuestStore(next);
    setProfile(next.profile);
    setTopicProgressMap(next.topicProgressMap);
    setDisciplineGoalsMap(next.disciplineGoalsMap);
    setStudySessions(next.studySessions);
    setSimuladoAttempts(next.simuladoAttempts);
    setErrorNotebook(next.errorNotebook);
    setMyMaterials(next.myMaterials);
    setMyQuestions(next.myQuestions);
  };

  const ensureSignedIn = (): User => {
    const current = auth.currentUser;
    if (!current) {
      throw new Error('Faça login para salvar seu progresso na nuvem.');
    }
    return current;
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        setWorkspaceAccessToken(null);
        let guestActive = false;
        try {
          guestActive = localStorage.getItem(GUEST_MODE_KEY) === 'true';
        } catch {
          guestActive = false;
        }
        setIsGuest(guestActive);
        if (guestActive) {
          hydrateGuestData();
        } else {
          setProfile(null);
          setTopicProgressMap({});
          setDisciplineGoalsMap({});
          setStudySessions([]);
          setSimuladoAttempts([]);
          setErrorNotebook([]);
          setMyMaterials([]);
          setMyQuestions([]);
          setMyFamilyMembership(null);
          setFamilyMembers([]);
          setAccessSessions([]);
        }
        setAuthLoading(false);
        return;
      }

      setIsGuest(false);
      try {
        localStorage.removeItem(GUEST_MODE_KEY);
      } catch {
        // ignore storage errors
      }

      const fallbackProfile: UserProfile = {
        uid: firebaseUser.uid,
        displayName: (firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Estudante ALEPA').slice(0, 120),
        role: 'student',
        dailyGoalMinutes: CONCURSO_PROFILE.dailyGoalMinutes,
        examDate: CONCURSO_PROFILE.examDate,
        targetCargo: 'Cargo 03 – Técnico Legislativo (PL.AL.102)',
      };
      setProfile((prev) => prev || fallbackProfile);

      try {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const snap = await getDoc(userRef);
        const isTeacherAdmin =
          Boolean(firebaseUser.emailVerified) && isAdminEmail(firebaseUser.email);
        if (!snap.exists()) {
          const newProfile = {
            uid: firebaseUser.uid,
            displayName: fallbackProfile.displayName,
            role: isTeacherAdmin ? 'teacher' : 'student',
            dailyGoalMinutes: CONCURSO_PROFILE.dailyGoalMinutes,
            examDate: CONCURSO_PROFILE.examDate,
            targetCargo: 'Cargo 03 – Técnico Legislativo (PL.AL.102)',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(userRef, newProfile);
        } else if (isTeacherAdmin && snap.data()?.role !== 'teacher') {
          await updateDoc(userRef, {
            role: 'teacher',
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        console.error('Erro ao inicializar perfil:', err);
      }
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;

    const uid = user.uid;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        doc(db, 'users', uid),
        (snap) => {
          if (snap.exists()) {
            setProfile(snap.data() as UserProfile);
          }
        },
        (err) => handleFirestoreError(err, OperationType.GET, `users/${uid}`)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, 'users', uid, 'topicProgress'),
        (snap) => {
          const next: Record<string, TopicProgress> = {};
          snap.forEach((docSnap) => {
            const data = docSnap.data() as TopicProgress;
            next[docSnap.id] = data;
          });
          setTopicProgressMap(next);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/topicProgress`)
      )
    );

    unsubs.push(
      onSnapshot(
        collection(db, 'users', uid, 'disciplineGoals'),
        (snap) => {
          const next: Record<string, DisciplineWeeklyGoal> = {};
          snap.forEach((docSnap) => {
            next[docSnap.id] = docSnap.data() as DisciplineWeeklyGoal;
          });
          setDisciplineGoalsMap(next);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/disciplineGoals`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'users', uid, 'studySessions'), orderBy('createdAt', 'desc')),
        (snap) => {
          const list: StudySession[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StudySession, 'id'>) }));
          setStudySessions(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/studySessions`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'users', uid, 'simuladoAttempts'), orderBy('createdAt', 'desc')),
        (snap) => {
          const list: SimuladoAttempt[] = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<SimuladoAttempt, 'id'>),
          }));
          setSimuladoAttempts(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/simuladoAttempts`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'users', uid, 'errorNotebook'), orderBy('updatedAt', 'desc')),
        (snap) => {
          const list: ErrorEntry[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ErrorEntry, 'id'>) }));
          setErrorNotebook(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/errorNotebook`)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'materials'), where('ownerId', '==', uid)),
        (snap) => {
          setMyMaterials(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StudyMaterial, 'id'>) })));
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'materials')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'sharedQuestions'), where('authorId', '==', uid)),
        (snap) => {
          setMyQuestions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) })));
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'sharedQuestions')
      )
    );

    if (user.emailVerified && user.email) {
      const famId = toFamilyMemberDocId(user.email);
      unsubs.push(
        onSnapshot(
          doc(db, 'familyMembers', famId),
          (snap) => {
            if (snap.exists()) {
              setMyFamilyMembership({ id: snap.id, ...(snap.data() as Omit<FamilyMember, 'id'>) });
            } else {
              setMyFamilyMembership(null);
            }
          },
          () => {
            setMyFamilyMembership(null);
          }
        )
      );
    } else {
      setMyFamilyMembership(null);
    }

    const userIsAdmin = Boolean(user.emailVerified && isAdminEmail(user.email));
    if (userIsAdmin) {
      unsubs.push(
        onSnapshot(
          collection(db, 'familyMembers'),
          (snap) => {
            setFamilyMembers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FamilyMember, 'id'>) })));
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'familyMembers')
        )
      );
      unsubs.push(
        onSnapshot(
          collection(db, 'accessSessions'),
          (snap) => {
            setAccessSessions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AccessSession, 'id'>) })));
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'accessSessions')
        )
      );
    } else {
      setFamilyMembers([]);
      unsubs.push(
        onSnapshot(
          query(collection(db, 'accessSessions'), where('userId', '==', uid)),
          (snap) => {
            setAccessSessions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AccessSession, 'id'>) })));
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'accessSessions')
        )
      );
    }

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [user]);

  useEffect(() => {
    const unsubSharedMaterials = onSnapshot(
      query(collection(db, 'materials'), where('isShared', '==', true)),
      (snap) => {
        setSharedMaterials(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StudyMaterial, 'id'>) })));
      },
      (err) => {
        console.warn('Falha ao sincronizar materiais compartilhados:', err);
      }
    );

    const unsubPublishedQuestions = onSnapshot(
      query(collection(db, 'sharedQuestions'), where('isPublished', '==', true)),
      (snap) => {
        setPublishedQuestions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) })));
      },
      (err) => {
        console.warn('Falha ao sincronizar questões publicadas:', err);
      }
    );

    return () => {
      unsubSharedMaterials();
      unsubPublishedQuestions();
    };
  }, []);

  const syncAccessPresence = useCallback(
    async (online: boolean) => {
      const current = auth.currentUser;
      if (!current) return;
      const devId = deviceIdRef.current;
      const sessionId = sanitizeId(`${current.uid}_${devId}`);
      const ref = doc(db, 'accessSessions', sessionId);
      const userIsAdmin = Boolean(current.emailVerified && isAdminEmail(current.email));
      const accessType: AccessSession['accessType'] = userIsAdmin
        ? 'admin'
        : myFamilyMembership?.active
          ? 'familiar'
          : 'estudante';
      const displayName = (
        profile?.displayName ||
        current.displayName ||
        current.email?.split('@')[0] ||
        'Visitante'
      ).slice(0, 120);
      const deviceType = detectDeviceType();
      const currentTab = (presenceContextRef.current.tab || 'dashboard').slice(0, 40);
      const activeCampus: CampusLevel = presenceContextRef.current.campus === 'medio' ? 'medio' : 'superior';

      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            userId: current.uid,
            deviceId: devId,
            displayName,
            accessType,
            deviceType,
            currentTab,
            activeCampus,
            isOnline: online,
            sessionStartedAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
          });
        } else {
          await updateDoc(ref, {
            displayName,
            accessType,
            deviceType,
            currentTab,
            activeCampus,
            isOnline: online,
            lastSeenAt: serverTimestamp(),
          });
        }
      } catch {
        // Non-blocking heartbeat error
      }
    },
    [profile?.displayName, myFamilyMembership?.active]
  );

  const updateAccessPresenceContext = useCallback(
    (tab: string, campus: CampusLevel) => {
      const prev = presenceContextRef.current;
      if (prev.tab === tab && prev.campus === campus) return;
      presenceContextRef.current = { tab, campus };
      if (auth.currentUser) {
        void syncAccessPresence(true);
      }
    },
    [syncAccessPresence]
  );

  useEffect(() => {
    if (!user) return;
    void syncAccessPresence(true);

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncAccessPresence(true);
      }
    }, 45000);

    const onVisibility = () => {
      void syncAccessPresence(document.visibilityState === 'visible');
    };
    const onPageHide = () => {
      void syncAccessPresence(false);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [user, syncAccessPresence]);

  const materials = React.useMemo(() => {
    const merged = new Map<string, StudyMaterial>();
    GERAL_DEFAULT_MATERIALS.forEach((m) => merged.set(m.id, m));
    DEFAULT_STUDY_MATERIALS.forEach((m) => merged.set(m.id, m));
    MEDIO_DEFAULT_MATERIALS.forEach((m) => merged.set(m.id, m));
    sharedMaterials.forEach((m) => merged.set(m.id, m));
    myMaterials.forEach((m) => merged.set(m.id, m));
    return Array.from(merged.values());
  }, [sharedMaterials, myMaterials]);

  const questions = React.useMemo(() => {
    const merged = new Map<string, Question>();
    CETAP_QUESTIONS.forEach((q) => merged.set(q.id, q));
    MEDIO_QUESTIONS.forEach((q) => merged.set(q.id, q));
    EXTRA_CURATED_QUESTIONS.forEach((q) => merged.set(q.id, q));
    publishedQuestions.forEach((q) => merged.set(q.id, q));
    myQuestions.forEach((q) => merged.set(q.id, q));
    return Array.from(merged.values());
  }, [publishedQuestions, myQuestions]);

  const loginWithEmail = async (email: string, password: string) => {
    setIsGuest(false);
    try {
      localStorage.removeItem(GUEST_MODE_KEY);
    } catch {
      // ignore
    }
    await signInWithEmailAndPassword(auth, email.trim(), password);
  };

  const registerWithEmail = async (
    email: string,
    password: string,
    displayName: string,
    _preferredRole: UserRole
  ) => {
    setIsGuest(false);
    try {
      localStorage.removeItem(GUEST_MODE_KEY);
    } catch {
      // ignore
    }
    const cleanName = displayName.trim().slice(0, 120);
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateProfile(cred.user, { displayName: cleanName });
    try {
      const userRef = doc(db, 'users', cred.user.uid);
      const snap = await getDoc(userRef);
      if (!snap.exists()) {
        await setDoc(userRef, {
          uid: cred.user.uid,
          displayName: cleanName || cred.user.email?.split('@')[0] || 'Estudante ALEPA',
          role: 'student',
          dailyGoalMinutes: CONCURSO_PROFILE.dailyGoalMinutes,
          examDate: CONCURSO_PROFILE.examDate,
          targetCargo: 'Cargo 03 – Técnico Legislativo (PL.AL.102)',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      console.error('Erro ao criar perfil inicial:', err);
    }
    // Optional non-blocking verification email
    void sendEmailVerification(cred.user).catch(() => {});
  };

  const loginWithGoogle = async () => {
    setIsGuest(false);
    try {
      localStorage.removeItem(GUEST_MODE_KEY);
    } catch {
      // ignore
    }
    const result = await signInWithPopup(auth, googleAuthProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      setWorkspaceAccessToken(credential.accessToken);
    }
  };

  const enterGuestMode = () => {
    try {
      localStorage.setItem(GUEST_MODE_KEY, 'true');
    } catch {
      // ignore
    }
    setIsGuest(true);
    setSyncError(null);
    hydrateGuestData();
  };

  const exitGuestMode = () => {
    try {
      localStorage.removeItem(GUEST_MODE_KEY);
    } catch {
      // ignore
    }
    setIsGuest(false);
  };

  const connectGoogleWorkspace = async (): Promise<string | null> => {
    const current = auth.currentUser;
    const hasGoogleLinked = current?.providerData.some((p) => p.providerId === 'google.com');

    workspaceAuthProvider.setCustomParameters({ prompt: 'consent select_account' });
    try {
      let result;
      if (current && hasGoogleLinked) {
        result = await reauthenticateWithPopup(current, workspaceAuthProvider);
      } else if (current) {
        try {
          result = await linkWithPopup(current, workspaceAuthProvider);
        } catch (linkErr: unknown) {
          const code = (linkErr as { code?: string })?.code || '';
          if (code === 'auth/credential-already-in-use' || code === 'auth/provider-already-linked') {
            result = await signInWithPopup(auth, workspaceAuthProvider);
          } else {
            throw linkErr;
          }
        }
      } else {
        result = await signInWithPopup(auth, workspaceAuthProvider);
      }

      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken || null;
      if (!token) {
        throw new Error('Não foi possível obter a autorização da sua conta Google Workspace.');
      }
      setWorkspaceAccessToken(token);
      return token;
    } finally {
      workspaceAuthProvider.setCustomParameters({});
    }
  };

  const clearWorkspaceToken = () => {
    setWorkspaceAccessToken(null);
  };

  const resendVerification = async () => {
    if (auth.currentUser) {
      await sendEmailVerification(auth.currentUser);
    }
  };

  const refreshAuthState = async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      setUser(auth.currentUser);
      setAuthRefreshTick((t) => t + 1);
      const userRef = doc(db, 'users', auth.currentUser.uid);
      const snap = await getDoc(userRef);
      const isTeacherAdmin =
        Boolean(auth.currentUser.emailVerified) && isAdminEmail(auth.currentUser.email);
      if (!snap.exists()) {
        await setDoc(userRef, {
          uid: auth.currentUser.uid,
          displayName: (
            auth.currentUser.displayName ||
            auth.currentUser.email?.split('@')[0] ||
            'Estudante ALEPA'
          ).slice(0, 120),
          role: isTeacherAdmin ? 'teacher' : 'student',
          dailyGoalMinutes: CONCURSO_PROFILE.dailyGoalMinutes,
          examDate: CONCURSO_PROFILE.examDate,
          targetCargo: 'Cargo 03 – Técnico Legislativo (PL.AL.102)',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else if (isTeacherAdmin && snap.data()?.role !== 'teacher') {
        await updateDoc(userRef, {
          role: 'teacher',
          updatedAt: serverTimestamp(),
        });
      }
    }
  };

  const logout = async () => {
    setWorkspaceAccessToken(null);
    if (isGuest && !auth.currentUser) {
      exitGuestMode();
      return;
    }
    if (auth.currentUser) {
      await syncAccessPresence(false);
    }
    await signOut(auth);
  };

  const updateProfileSettings = async (patch: { displayName?: string; dailyGoalMinutes?: number }) => {
    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        profile: {
          ...prev.profile,
          displayName:
            patch.displayName !== undefined ? patch.displayName.trim().slice(0, 120) : prev.profile.displayName,
          dailyGoalMinutes:
            patch.dailyGoalMinutes !== undefined
              ? Math.max(15, Math.min(720, Math.round(patch.dailyGoalMinutes)))
              : prev.profile.dailyGoalMinutes,
        },
      }));
      return;
    }
    const current = ensureSignedIn();
    const path = `users/${current.uid}`;
    try {
      const ref = doc(db, 'users', current.uid);
      const updates: Record<string, unknown> = { updatedAt: serverTimestamp() };
      if (patch.displayName !== undefined) updates.displayName = patch.displayName.trim().slice(0, 120);
      if (patch.dailyGoalMinutes !== undefined) {
        updates.dailyGoalMinutes = Math.max(15, Math.min(720, Math.round(patch.dailyGoalMinutes)));
      }
      await updateDoc(ref, updates);
    } catch (err) {
      setSyncError('Não foi possível atualizar seu perfil agora.');
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const saveDisciplineWeeklyGoal = async (disciplineId: string, weeklyGoalMinutes: number) => {
    const safeDiscId = sanitizeId(disciplineId).slice(0, 80);
    const clampedMinutes = Math.max(15, Math.min(2520, Math.round(weeklyGoalMinutes)));

    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        disciplineGoalsMap: {
          ...prev.disciplineGoalsMap,
          [safeDiscId]: {
            userId: GUEST_UID,
            disciplineId: safeDiscId,
            weeklyGoalMinutes: clampedMinutes,
          },
        },
      }));
      return;
    }

    const current = ensureSignedIn();
    const existing = disciplineGoalsMap[safeDiscId];
    const path = `users/${current.uid}/disciplineGoals/${safeDiscId}`;
    try {
      const ref = doc(db, 'users', current.uid, 'disciplineGoals', safeDiscId);
      if (existing) {
        await updateDoc(ref, {
          weeklyGoalMinutes: clampedMinutes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          userId: current.uid,
          disciplineId: safeDiscId,
          weeklyGoalMinutes: clampedMinutes,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      setSyncError('Erro ao salvar meta semanal da disciplina.');
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const saveTopicProgress = async (
    topicId: string,
    disciplineId: string,
    patch: Partial<Pick<TopicProgress, 'theoryDone' | 'questionsDone' | 'revisionDone' | 'notes'>>
  ) => {
    const safeTopicId = sanitizeId(topicId);
    const existing = topicProgressMap[safeTopicId];
    const theoryDone = patch.theoryDone ?? existing?.theoryDone ?? false;
    const questionsDone = patch.questionsDone ?? existing?.questionsDone ?? false;
    const revisionDone = patch.revisionDone ?? existing?.revisionDone ?? false;
    const notes = (patch.notes ?? existing?.notes ?? '').slice(0, 2000);
    const masteryLevel = Math.round(
      ((theoryDone ? 40 : 0) + (questionsDone ? 40 : 0) + (revisionDone ? 20 : 0))
    );

    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        topicProgressMap: {
          ...prev.topicProgressMap,
          [safeTopicId]: {
            userId: GUEST_UID,
            topicId: safeTopicId,
            disciplineId: disciplineId.slice(0, 80),
            theoryDone,
            questionsDone,
            revisionDone,
            masteryLevel,
            notes,
          },
        },
      }));
      return;
    }

    const current = ensureSignedIn();
    const path = `users/${current.uid}/topicProgress/${safeTopicId}`;
    try {
      const ref = doc(db, 'users', current.uid, 'topicProgress', safeTopicId);
      if (existing) {
        await updateDoc(ref, {
          theoryDone,
          questionsDone,
          revisionDone,
          masteryLevel,
          notes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          userId: current.uid,
          topicId: safeTopicId,
          disciplineId: disciplineId.slice(0, 80),
          theoryDone,
          questionsDone,
          revisionDone,
          masteryLevel,
          notes,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      setSyncError('Erro ao salvar progresso do tópico.');
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const logStudySession = async (input: {
    dateKey: string;
    disciplineId: string;
    topicTitle: string;
    blockType: BlockType;
    durationMinutes: number;
    notes?: string;
  }) => {
    const sessionId = sanitizeId(`ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    if (isGuest && !auth.currentUser) {
      const newSession: StudySession = {
        id: sessionId,
        userId: GUEST_UID,
        dateKey: input.dateKey.slice(0, 20),
        disciplineId: input.disciplineId.slice(0, 80),
        topicTitle: input.topicTitle.trim().slice(0, 200) || 'Sessão de estudo',
        blockType: input.blockType,
        durationMinutes: Math.max(1, Math.min(600, Math.round(input.durationMinutes))),
        notes: (input.notes || '').slice(0, 1000),
      };
      persistGuestPatch((prev) => ({
        ...prev,
        studySessions: [newSession, ...prev.studySessions],
      }));
      return;
    }

    const current = ensureSignedIn();
    const path = `users/${current.uid}/studySessions/${sessionId}`;
    try {
      await setDoc(doc(db, 'users', current.uid, 'studySessions', sessionId), {
        userId: current.uid,
        dateKey: input.dateKey.slice(0, 20),
        disciplineId: input.disciplineId.slice(0, 80),
        topicTitle: input.topicTitle.trim().slice(0, 200) || 'Sessão de estudo',
        blockType: input.blockType,
        durationMinutes: Math.max(1, Math.min(600, Math.round(input.durationMinutes))),
        notes: (input.notes || '').slice(0, 1000),
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao registrar sessão de estudo.');
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const saveSimuladoAttempt = async (input: {
    title: string;
    mode: 'treino' | 'simulado';
    primaryDisciplineId: string;
    totalQuestions: number;
    correctCount: number;
    score: number;
    durationSeconds: number;
  }) => {
    const attemptId = sanitizeId(`sim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    if (isGuest && !auth.currentUser) {
      const attempt: SimuladoAttempt = {
        id: attemptId,
        userId: GUEST_UID,
        title: input.title.trim().slice(0, 160),
        mode: input.mode,
        primaryDisciplineId: input.primaryDisciplineId.slice(0, 80),
        totalQuestions: Math.max(1, Math.min(200, Math.round(input.totalQuestions))),
        correctCount: Math.max(0, Math.min(input.totalQuestions, Math.round(input.correctCount))),
        score: Math.max(0, Math.min(10, Number(input.score.toFixed(2)))),
        durationSeconds: Math.max(0, Math.min(36000, Math.round(input.durationSeconds))),
      };
      persistGuestPatch((prev) => ({
        ...prev,
        simuladoAttempts: [attempt, ...prev.simuladoAttempts],
      }));
      return;
    }

    const current = ensureSignedIn();
    const path = `users/${current.uid}/simuladoAttempts/${attemptId}`;
    try {
      await setDoc(doc(db, 'users', current.uid, 'simuladoAttempts', attemptId), {
        userId: current.uid,
        title: input.title.trim().slice(0, 160),
        mode: input.mode,
        primaryDisciplineId: input.primaryDisciplineId.slice(0, 80),
        totalQuestions: Math.max(1, Math.min(200, Math.round(input.totalQuestions))),
        correctCount: Math.max(0, Math.min(input.totalQuestions, Math.round(input.correctCount))),
        score: Math.max(0, Math.min(10, Number(input.score.toFixed(2)))),
        durationSeconds: Math.max(0, Math.min(36000, Math.round(input.durationSeconds))),
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao salvar resultado do simulado.');
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const addErrorEntry = async (input: {
    questionId: string;
    disciplineId: string;
    topicTitle: string;
    questionStem: string;
    correctOption: string;
    selectedOption: string;
    errorReason: ErrorReason;
    improvementNote: string;
  }) => {
    const safeQuestionId = sanitizeId(input.questionId);
    const entryId = sanitizeId(`err_${safeQuestionId}`);

    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => {
        const existingIdx = prev.errorNotebook.findIndex((e) => e.id === entryId);
        if (existingIdx >= 0) {
          const updated = [...prev.errorNotebook];
          updated[existingIdx] = {
            ...updated[existingIdx],
            errorReason: input.errorReason,
            improvementNote: input.improvementNote.slice(0, 2000),
            nextReviewDate: addDaysIso(1),
            reviewCount: updated[existingIdx].reviewCount + 1,
            status: 'pending',
          };
          return { ...prev, errorNotebook: updated };
        }
        const entry: ErrorEntry = {
          id: entryId,
          userId: GUEST_UID,
          questionId: safeQuestionId,
          disciplineId: input.disciplineId.slice(0, 80),
          topicTitle: input.topicTitle.slice(0, 200),
          questionStem: input.questionStem.slice(0, 2000),
          correctOption: input.correctOption.slice(0, 500),
          selectedOption: input.selectedOption.slice(0, 500),
          errorReason: input.errorReason,
          improvementNote: input.improvementNote.slice(0, 2000),
          nextReviewDate: addDaysIso(1),
          reviewCount: 0,
          status: 'pending',
        };
        return { ...prev, errorNotebook: [entry, ...prev.errorNotebook] };
      });
      return;
    }

    const current = ensureSignedIn();
    const path = `users/${current.uid}/errorNotebook/${entryId}`;
    const existing = errorNotebook.find((e) => e.id === entryId);
    try {
      if (existing) {
        await updateDoc(doc(db, 'users', current.uid, 'errorNotebook', entryId), {
          errorReason: input.errorReason,
          improvementNote: input.improvementNote.slice(0, 2000),
          nextReviewDate: addDaysIso(1),
          reviewCount: existing.reviewCount + 1,
          status: 'pending',
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'users', current.uid, 'errorNotebook', entryId), {
          userId: current.uid,
          questionId: safeQuestionId,
          disciplineId: input.disciplineId.slice(0, 80),
          topicTitle: input.topicTitle.slice(0, 200),
          questionStem: input.questionStem.slice(0, 2000),
          correctOption: input.correctOption.slice(0, 500),
          selectedOption: input.selectedOption.slice(0, 500),
          errorReason: input.errorReason,
          improvementNote: input.improvementNote.slice(0, 2000),
          nextReviewDate: addDaysIso(1),
          reviewCount: 0,
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      setSyncError('Erro ao salvar no Caderno de Erros.');
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const updateErrorEntry = async (
    entryId: string,
    patch: Partial<Pick<ErrorEntry, 'errorReason' | 'improvementNote' | 'nextReviewDate' | 'reviewCount' | 'status'>>
  ) => {
    const safeId = sanitizeId(entryId);
    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        errorNotebook: prev.errorNotebook.map((item) =>
          item.id === safeId
            ? {
                ...item,
                errorReason: patch.errorReason ?? item.errorReason,
                improvementNote: (patch.improvementNote ?? item.improvementNote).slice(0, 2000),
                nextReviewDate: (patch.nextReviewDate ?? item.nextReviewDate).slice(0, 20),
                reviewCount: patch.reviewCount ?? item.reviewCount,
                status: patch.status ?? item.status,
              }
            : item
        ),
      }));
      return;
    }

    const current = ensureSignedIn();
    const existing = errorNotebook.find((e) => e.id === safeId);
    if (!existing) return;
    const path = `users/${current.uid}/errorNotebook/${safeId}`;
    try {
      await updateDoc(doc(db, 'users', current.uid, 'errorNotebook', safeId), {
        errorReason: patch.errorReason ?? existing.errorReason,
        improvementNote: (patch.improvementNote ?? existing.improvementNote).slice(0, 2000),
        nextReviewDate: (patch.nextReviewDate ?? existing.nextReviewDate).slice(0, 20),
        reviewCount: patch.reviewCount ?? existing.reviewCount,
        status: patch.status ?? existing.status,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao atualizar revisão.');
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteErrorEntry = async (entryId: string) => {
    const safeId = sanitizeId(entryId);
    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        errorNotebook: prev.errorNotebook.filter((item) => item.id !== safeId),
      }));
      return;
    }

    const current = ensureSignedIn();
    const path = `users/${current.uid}/errorNotebook/${safeId}`;
    try {
      await deleteDoc(doc(db, 'users', current.uid, 'errorNotebook', safeId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addMaterial = async (input: {
    title: string;
    disciplineId: string;
    libraryCategoryId?: LibraryCategoryId;
    editalTopic?: string;
    resourceType?: ResourceType;
    fileType: MaterialFileType;
    institution?: string;
    url: string;
    pricing?: 'gratuito' | 'pago';
    publishedAt?: string;
    lastVerifiedAt?: string;
    linkStatus?: LinkStatus;
    isOfficialContent?: boolean;
    fileName?: string;
    description?: string;
    isShared?: boolean;
  }) => {
    const materialId = sanitizeId(`mat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const todayIso = addDaysIso(0);

    if (isGuest && !auth.currentUser) {
      const newMat: StudyMaterial = {
        id: materialId,
        ownerId: GUEST_UID,
        title: input.title.trim().slice(0, 200),
        disciplineId: input.disciplineId.slice(0, 80),
        libraryCategoryId: input.libraryCategoryId,
        editalTopic: input.editalTopic?.trim().slice(0, 240),
        resourceType: input.resourceType,
        fileType: input.fileType,
        institution: input.institution?.trim().slice(0, 160),
        url: input.url.trim().slice(0, 2000),
        pricing: input.pricing,
        publishedAt: (input.publishedAt || todayIso).slice(0, 20),
        lastVerifiedAt: (input.lastVerifiedAt || todayIso).slice(0, 20),
        linkStatus: input.linkStatus,
        isOfficialContent: input.isOfficialContent,
        fileName: (input.fileName || '').slice(0, 240),
        description: (input.description || '').slice(0, 1000),
        isShared: false,
      };
      persistGuestPatch((prev) => ({
        ...prev,
        myMaterials: [newMat, ...prev.myMaterials],
      }));
      return;
    }

    const current = ensureSignedIn();
    const canShare = Boolean(input.isShared && canPublishShared);
    const path = `materials/${materialId}`;
    try {
      const payload: Record<string, unknown> = {
        ownerId: current.uid,
        title: input.title.trim().slice(0, 200),
        disciplineId: input.disciplineId.slice(0, 80),
        fileType: input.fileType,
        url: input.url.trim().slice(0, 2000),
        fileName: (input.fileName || '').slice(0, 240),
        description: (input.description || '').slice(0, 1000),
        isShared: canShare,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (input.libraryCategoryId) payload.libraryCategoryId = input.libraryCategoryId.slice(0, 80);
      if (input.editalTopic) payload.editalTopic = input.editalTopic.trim().slice(0, 240);
      if (input.resourceType) payload.resourceType = input.resourceType;
      if (input.institution) payload.institution = input.institution.trim().slice(0, 160);
      if (input.pricing) payload.pricing = input.pricing;
      payload.publishedAt = (input.publishedAt || todayIso).slice(0, 20);
      payload.lastVerifiedAt = (input.lastVerifiedAt || todayIso).slice(0, 20);
      if (input.linkStatus) payload.linkStatus = input.linkStatus;
      if (input.isOfficialContent !== undefined) payload.isOfficialContent = Boolean(input.isOfficialContent);

      await setDoc(doc(db, 'materials', materialId), payload);
    } catch (err) {
      setSyncError('Erro ao salvar material.');
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const deleteMaterial = async (materialId: string) => {
    const safeId = sanitizeId(materialId);
    if (isGuest && !auth.currentUser) {
      persistGuestPatch((prev) => ({
        ...prev,
        myMaterials: prev.myMaterials.filter((m) => m.id !== safeId),
      }));
      return;
    }

    ensureSignedIn();
    const path = `materials/${safeId}`;
    try {
      await deleteDoc(doc(db, 'materials', safeId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addCustomQuestion = async (input: {
    disciplineId: string;
    topicTitle: string;
    statement: string;
    options: [string, string, string, string, string];
    correctIndex: number;
    explanation: string;
    legalBasis?: string;
    source?: string;
    originType?: QuestionOriginType;
    isOfficial?: boolean;
    isPublished?: boolean;
  }) => {
    const questionId = sanitizeId(`q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const originType: QuestionOriginType = input.originType || 'training_platform';
    const isOfficial = input.isOfficial ?? originType !== 'training_platform';

    if (isGuest && !auth.currentUser) {
      const newQuestion: Question = {
        id: questionId,
        authorId: GUEST_UID,
        disciplineId: input.disciplineId.slice(0, 80),
        topicTitle: input.topicTitle.trim().slice(0, 200),
        statement: input.statement.trim().slice(0, 2500),
        options: input.options.map((o) => o.trim().slice(0, 500)) as [string, string, string, string, string],
        correctIndex: Math.max(0, Math.min(4, Math.round(input.correctIndex))),
        explanation: input.explanation.trim().slice(0, 2000),
        legalBasis: (input.legalBasis || '').slice(0, 400),
        source: (
          input.source || (isOfficial ? 'Prova / Fonte Oficial' : 'Treinamento Complementar (Não Oficial)')
        ).slice(0, 160),
        originType,
        isOfficial,
        isPublished: false,
      };
      persistGuestPatch((prev) => ({
        ...prev,
        myQuestions: [newQuestion, ...prev.myQuestions],
      }));
      return;
    }

    const current = ensureSignedIn();
    const canPublish = Boolean(input.isPublished && canPublishShared);
    const path = `sharedQuestions/${questionId}`;
    try {
      await setDoc(doc(db, 'sharedQuestions', questionId), {
        authorId: current.uid,
        disciplineId: input.disciplineId.slice(0, 80),
        topicTitle: input.topicTitle.trim().slice(0, 200),
        statement: input.statement.trim().slice(0, 2500),
        options: input.options.map((o) => o.trim().slice(0, 500)),
        correctIndex: Math.max(0, Math.min(4, Math.round(input.correctIndex))),
        explanation: input.explanation.trim().slice(0, 2000),
        legalBasis: (input.legalBasis || '').slice(0, 400),
        source: (
          input.source || (isOfficial ? 'Prova / Fonte Oficial' : 'Treinamento Complementar (Não Oficial)')
        ).slice(0, 160),
        originType,
        isOfficial,
        isPublished: canPublish,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao salvar questão.');
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const inviteFamilyMember = async (input: {
    name: string;
    email: string;
    relationship: string;
    canPublish: boolean;
  }) => {
    const current = ensureSignedIn();
    const cleanEmail = input.email.trim().toLowerCase().slice(0, 160);
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Informe um e-mail válido do familiar.');
    }
    const memberId = toFamilyMemberDocId(cleanEmail);
    const path = `familyMembers/${memberId}`;
    try {
      const ref = doc(db, 'familyMembers', memberId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, {
          name: input.name.trim().slice(0, 120) || cleanEmail.split('@')[0],
          relationship: input.relationship.trim().slice(0, 60) || 'Familiar',
          canPublish: Boolean(input.canPublish),
          active: true,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          memberId,
          name: input.name.trim().slice(0, 120) || cleanEmail.split('@')[0],
          email: cleanEmail,
          relationship: input.relationship.trim().slice(0, 60) || 'Familiar',
          canPublish: Boolean(input.canPublish),
          active: true,
          invitedByUid: current.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      setSyncError('Erro ao salvar autorização do familiar.');
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  };

  const toggleFamilyMemberPublish = async (memberId: string, canPublish: boolean) => {
    ensureSignedIn();
    const safeId = sanitizeId(memberId);
    const path = `familyMembers/${safeId}`;
    try {
      await updateDoc(doc(db, 'familyMembers', safeId), {
        canPublish: Boolean(canPublish),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao atualizar permissão do familiar.');
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const toggleFamilyMemberActive = async (memberId: string, active: boolean) => {
    ensureSignedIn();
    const safeId = sanitizeId(memberId);
    const path = `familyMembers/${safeId}`;
    try {
      await updateDoc(doc(db, 'familyMembers', safeId), {
        active: Boolean(active),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setSyncError('Erro ao atualizar status do familiar.');
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const removeFamilyMember = async (memberId: string) => {
    ensureSignedIn();
    const safeId = sanitizeId(memberId);
    const path = `familyMembers/${safeId}`;
    try {
      await deleteDoc(doc(db, 'familyMembers', safeId));
    } catch (err) {
      setSyncError('Erro ao remover familiar.');
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isGuest,
        profile,
        authLoading,
        syncError,
        clearSyncError: () => setSyncError(null),
        workspaceAccessToken,
        connectGoogleWorkspace,
        clearWorkspaceToken,
        isAdmin,
        canPublishShared,
        myFamilyMembership,
        familyMembers,
        accessSessions,
        updateAccessPresenceContext,
        inviteFamilyMember,
        toggleFamilyMemberPublish,
        toggleFamilyMemberActive,
        removeFamilyMember,
        topicProgressMap,
        disciplineGoalsMap,
        studySessions,
        simuladoAttempts,
        errorNotebook,
        materials,
        questions,
        loginWithEmail,
        registerWithEmail,
        loginWithGoogle,
        enterGuestMode,
        exitGuestMode,
        resendVerification,
        refreshAuthState,
        logout,
        updateProfileSettings,
        saveDisciplineWeeklyGoal,
        saveTopicProgress,
        logStudySession,
        saveSimuladoAttempt,
        addErrorEntry,
        updateErrorEntry,
        deleteErrorEntry,
        addMaterial,
        deleteMaterial,
        addCustomQuestion,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser utilizado dentro de AuthProvider');
  return ctx;
}
