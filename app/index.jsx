import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { db } from '../lib/firebase';

// ─── AsyncStorage keys (profile only — data lives in Firestore) ───────────────
const PROFILE_KEY = 'userProfile';

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function generateId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ─── Name-similarity helpers (dedup suggestions) ─────────────────────────────
const SUGGEST_STOP = new Set(['with','and','the','for','from','this','that','using','style','fresh','homemade','easy','simple','quick','low','high']);
// Cache tokenization — food names are stable strings, no reason to re-run regex
const _tokenCache = new Map();
const nameTokens = (name) => {
  if (!name) return [];
  let r = _tokenCache.get(name);
  if (!r) {
    r = name.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)
      .filter(w => w.length >= 4 && !SUGGEST_STOP.has(w));
    _tokenCache.set(name, r);
  }
  return r;
};
// Returns true if candidateName shares a root word with any token in tokenList
const similarToAny = (candidateName, tokenList) => {
  if (!tokenList.length) return false;
  const ct = nameTokens(candidateName);
  return ct.some(a => tokenList.some(b => a.startsWith(b) || b.startsWith(a)));
};

// ─── Fill Day quick-search shortcuts (tap to paste into search box) ──────────
const FILL_SHORTCUTS = [
  { label: '🫓 Roti',    text: 'roti' },
  { label: '🍚 Rice',    text: 'rice' },
  { label: '🫘 Dal',     text: 'dal' },
  { label: '🌮 Mexican', text: 'taco' },
  { label: '🥚 Eggs',    text: 'egg' },
  { label: '🥗 Salad',   text: 'salad' },
  { label: '🥪 Wrap',    text: 'wrap' },
  { label: '🍗 Chicken', text: 'chicken' },
];

// ─── Memoized FoodItem — prevents FlatList from re-rendering unchanged rows ──
const FoodItem = React.memo(function FoodItem({
  food, isEditing, editingData,
  onStartEdit, onCancel, onSave, onChangeField, onDelete,
}) {
  if (isEditing && editingData) {
    return (
      <View style={styles.foodItem}>
        <View style={styles.editingContainer}>
          <TextInput style={styles.input} value={String(editingData.name ?? '')}
            onChangeText={text => onChangeField('name', text)} placeholder="Food name" />
          <TextInput style={styles.input} value={String(editingData.servingSize ?? '')}
            onChangeText={text => onChangeField('servingSize', text)} placeholder="Serving size" />
          <View style={styles.macroEditGrid}>
            {['calories','protein','carbs','fats','sugar','addedSugar','sodium','fiber'].map(field => (
              <TextInput key={field} style={styles.macroInput}
                value={String(editingData[field] ?? '')}
                onChangeText={text => onChangeField(field, text)}
                placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                keyboardType="numeric" />
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 10 }}>
            <Switch
              value={!!editingData.oncePerDay}
              onValueChange={val => onChangeField('oncePerDay', val)}
              trackColor={{ false: '#d1d5db', true: '#a78bfa' }}
              thumbColor={editingData.oncePerDay ? '#7c3aed' : '#9ca3af'}
            />
            <Text style={{ color: '#374151', fontSize: 13 }}>Once per day (e.g. protein powder, yogurt)</Text>
          </View>
          <View style={styles.editActions}>
            <Pressable onPress={() => onSave(editingData)} style={styles.iconButton}>
              <Ionicons name="checkmark" size={24} color="#10b981" />
            </Pressable>
            <Pressable onPress={onCancel} style={styles.iconButton}>
              <Ionicons name="close" size={24} color="#6b7280" />
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.foodItem}>
      <View style={styles.foodHeader}>
        <View style={styles.foodInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.foodName}>{food.name}</Text>
            {food.oncePerDay && (
              <View style={{ backgroundColor: '#ede9fe', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ color: '#7c3aed', fontSize: 10, fontWeight: '600' }}>1×/day</Text>
              </View>
            )}
          </View>
          <Text style={styles.foodServing}>{food.servingSize}</Text>
        </View>
        <View style={styles.foodActions}>
          <Pressable onPress={() => onStartEdit(food)} style={styles.iconButton}>
            <Ionicons name="create-outline" size={20} color="#3b82f6" />
          </Pressable>
          <Pressable onPress={() => onDelete(food.id)} style={styles.iconButton}>
            <Ionicons name="trash-outline" size={20} color="#ef4444" />
          </Pressable>
        </View>
      </View>
      <View style={styles.macroGrid}>
        <Text style={styles.macroText}>Cal: {food.calories}</Text>
        <Text style={styles.macroText}>Protein: {food.protein}g</Text>
        <Text style={styles.macroText}>Carbs: {food.carbs}g</Text>
        <Text style={styles.macroText}>Fats: {food.fats}g</Text>
        <Text style={styles.macroText}>Sugar: {food.sugar}g</Text>
        <Text style={styles.macroText}>Added: {food.addedSugar}g</Text>
        <Text style={styles.macroText}>Fiber: {food.fiber}g</Text>
        <Text style={styles.macroText}>Sodium: {food.sodium}mg</Text>
      </View>
    </View>
  );
});

export default function App() {
  // ─── Profile / family state ──────────────────────────────────────────────
  const [userId, setUserId] = useState(null);
  const [familyId, setFamilyId] = useState(null);
  const [userName, setUserName] = useState('');
  const [familyMembers, setFamilyMembers] = useState([]);
  const [viewingUserId, setViewingUserId] = useState(null);

  // first-launch setup modal
  const [showSetup, setShowSetup] = useState(false);
  const [setupName, setSetupName] = useState('');
  const [setupMode, setSetupMode] = useState('create'); // 'create' | 'join'
  const [setupCode, setSetupCode] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);

  // ─── Refs so async callbacks (setTimeout, Alert.onPress) always see latest values ──
  const actionGuard = useRef(false);   // prevents double-press on any primary action
  const userIdRef = useRef(null);
  const familyIdRef = useRef(null);
  const userNameRef = useRef('');
  const allMealsRef = useRef([]);
  const allRecipesRef = useRef([]);

  useEffect(() => { userIdRef.current = userId; }, [userId]);
  useEffect(() => { familyIdRef.current = familyId; }, [familyId]);
  useEffect(() => { userNameRef.current = userName; }, [userName]);
  useEffect(() => { allMealsRef.current = allMeals; }, [allMeals]);
  useEffect(() => { allRecipesRef.current = allRecipes; }, [allRecipes]);

  // ─── App data state (sourced from Firestore) ────────────────────────────
  const [foods, setFoods] = useState([]);
  const [allMeals, setAllMeals] = useState([]);   // all family members' meals
  const [allRecipes, setAllRecipes] = useState([]); // all family members' recipes
  const [hydrated, setHydrated] = useState(false);

  // ─── UI state ────────────────────────────────────────────────────────────
  const [showAddFood, setShowAddFood] = useState(false);
  const [showAddMeal, setShowAddMeal] = useState(false);
  const [editingFood, setEditingFood] = useState(null);
  const [swapMeal, setSwapMeal] = useState(null);
  const [swapDate, setSwapDate] = useState('');
  const [swapServings, setSwapServings] = useState('');
  const [swapMode, setSwapMode] = useState('servings');     // 'servings' | 'amount'
  const [swapMealType, setSwapMealType] = useState('');      // selected meal type in edit modal
  const [showRecipeBuilder, setShowRecipeBuilder] = useState(false);

  const [editingRecipeId, setEditingRecipeId] = useState(null);
  const [newRecipeName, setNewRecipeName] = useState('');
  const [newRecipeItems, setNewRecipeItems] = useState([]);
  const [recipeYield, setRecipeYield] = useState('2');
  const [recipeSearch, setRecipeSearch] = useState('');     // used in Log Meal modal
  const [recipeLibSearch, setRecipeLibSearch] = useState(''); // used in Recipe Library on dashboard

  const [recipeFoodPickerId, setRecipeFoodPickerId] = useState('');
  const [recipeFoodServings, setRecipeFoodServings] = useState('1');
  const [recipeFoodUnits, setRecipeFoodUnits] = useState('100');
  const [foodSearch, setFoodSearch] = useState('');

  // ─── Bulk transfer state ──────────────────────────────────────────────────
  const [showBulkTransfer, setShowBulkTransfer] = useState(false);
  const [bulkSource, setBulkSource] = useState('day');         // 'day' | mealType string
  const [bulkAction, setBulkAction] = useState('move');         // 'move' | 'copy'
  const [bulkTargetDate, setBulkTargetDate] = useState('');
  const [bulkTargetType, setBulkTargetType] = useState('');     // '' = keep same type
  const [bulkTargetUserId, setBulkTargetUserId] = useState(''); // '' = same user

  // ─── Recipe instance expand/collapse in daily log ─────────────────────────
  const [expandedRecipeInstances, setExpandedRecipeInstances] = useState(new Set());

  const [logMode, setLogMode] = useState('food');
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [recipeDraftItems, setRecipeDraftItems] = useState([]);

  const [recipeInputMode, setRecipeInputMode] = useState('servings');
  const [mealInputMode, setMealInputMode] = useState('servings');
  const [mealAmount, setMealAmount] = useState('1');

  const [recipePortionsEaten, setRecipePortionsEaten] = useState('1');
  const [recipeLogMode, setRecipeLogMode] = useState('portions');
  const [recipeLoggedWeight, setRecipeLoggedWeight] = useState('');
  const [recipeFinalWeight, setRecipeFinalWeight] = useState('');
  const [recipeIngredientSearch, setRecipeIngredientSearch] = useState('');

  const [showStats, setShowStats] = useState(false);
  const [statsTab, setStatsTab] = useState('weekly'); // 'weekly' | 'monthly'
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestTab, setSuggestTab] = useState('frequent'); // 'frequent' | 'bytype' | 'sameday' | 'fillday'
  const [suggestMealType, setSuggestMealType] = useState('breakfast');
  // Fill Day: dismissed items (session-only) + text search
  const [dismissedFillFoods, setDismissedFillFoods] = useState(new Set());
  const [dismissedFillRecipes, setDismissedFillRecipes] = useState(new Set());
  const [fillSearch, setFillSearch] = useState('');

  // ─── Macro targets ────────────────────────────────────────────────────────
  const DEFAULT_TARGETS = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0, sodium: 0, sugar: 0, addedSugar: 0 };
  const [userTargets, setUserTargets] = useState(DEFAULT_TARGETS);
  const [showSetTargets, setShowSetTargets] = useState(false);
  const [draftTargets, setDraftTargets] = useState(DEFAULT_TARGETS);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().toISOString().substring(0, 7));
  const [importProgress, setImportProgress] = useState(null); // null | { done, total, phase }

  const [newFood, setNewFood] = useState({
    name: '', servingSize: '', calories: '', protein: '',
    carbs: '', fats: '', sugar: '', addedSugar: '', sodium: '', fiber: '',
  });

  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [mealType, setMealType] = useState('breakfast');
  const [selectedFoodId, setSelectedFoodId] = useState('');

  // ─── Derived data ────────────────────────────────────────────────────────
  const isViewingOwn = viewingUserId === userId;
  const meals = useMemo(
    () => allMeals.filter(m => m.userId === viewingUserId),
    [allMeals, viewingUserId]
  );
  // All family recipes are shared — any member can see and log them.
  // Edit/delete is restricted to the creator (r.userId === userId) in the UI.
  const recipes = useMemo(
    () => allRecipes,
    [allRecipes]
  );

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const MEASURABLE_UNITS = [
    'g', 'gram', 'grams', 'kg', 'mg',
    'ml', 'l', 'liter', 'liters',
    'cup', 'cups', 'tbsp', 'tsp',
    'oz', 'fl oz', 'lb',
  ];

  const normalizeUnit = (unit) => {
    const u = String(unit || '').trim().toLowerCase();
    const map = {
      gram: 'g', grams: 'g', kg: 'kg', mg: 'mg',
      liter: 'l', liters: 'l', cup: 'cup', cups: 'cup',
      tbsp: 'tbsp', tsp: 'tsp', oz: 'oz', 'fl oz': 'fl oz',
      lb: 'lb', ml: 'ml', l: 'l',
    };
    return map[u] || u;
  };

  // Expand abbreviated units to full readable names for display
  const expandUnit = (unit) => {
    const u = String(unit || '').trim().toLowerCase();
    const map = {
      g: 'grams', kg: 'kilograms', mg: 'milligrams',
      ml: 'milliliters', l: 'liters',
      cup: 'cups', tbsp: 'tablespoons', tsp: 'teaspoons',
      oz: 'ounces', 'fl oz': 'fluid ounces', lb: 'pounds',
    };
    const expanded = map[u] || unit || '';
    return expanded.charAt(0).toUpperCase() + expanded.slice(1);
  };

  const extractServingUnit = (servingSize) => {
    if (!servingSize) return null;
    const text = String(servingSize).trim().toLowerCase();
    const match = text.match(/^([\d.]+)\s*([a-zA-Z].*)$/);
    if (!match) return null;
    const amount = parseFloat(match[1]);
    const unit = normalizeUnit(match[2].trim());
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!MEASURABLE_UNITS.includes(unit)) return null;
    return { amountPerServing: amount, unit };
  };

  const extractServingQuantity = (servingSize) => {
    if (!servingSize) return null;
    const text = String(servingSize).trim().toLowerCase();
    const match = text.match(/^([\d.]+)\s+(.+)$/);
    if (!match) return null;
    const qty = parseFloat(match[1]);
    const rawUnit = match[2].trim();
    const unit = normalizeUnit(rawUnit);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (MEASURABLE_UNITS.includes(unit)) return null;
    return { quantityPerServing: qty, quantityUnit: rawUnit || 'item(s)' };
  };

  const extractServingAmount = (servingSize) => {
    const measurable = extractServingUnit(servingSize);
    if (measurable) return { kind: 'measurable', perServing: measurable.amountPerServing, label: measurable.unit };
    const quantity = extractServingQuantity(servingSize);
    if (quantity) return { kind: 'count', perServing: quantity.quantityPerServing, label: quantity.quantityUnit };
    return null;
  };

  const toServingsFromInput = (food, mode, amountRaw) => {
    const amount = parseFloat(String(amountRaw));
    if (!food || !Number.isFinite(amount) || amount <= 0) return NaN;
    if (mode === 'servings') return amount;
    if (mode === 'amount') {
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed || !Number.isFinite(parsed.perServing) || parsed.perServing <= 0) return NaN;
      return amount / parsed.perServing;
    }
    return NaN;
  };

  const toServings = (food, item) => {
    if (!food || !item) return NaN;
    if (item.mode === 'servings') {
      const amt = parseFloat(String(item.amount ?? ''));
      return Number.isFinite(amt) ? amt : NaN;
    }
    if (item.mode === 'amount') {
      const rawAmount = parseFloat(String(item.amount ?? ''));
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) return NaN;
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed || !Number.isFinite(parsed.perServing) || parsed.perServing <= 0) return NaN;
      return rawAmount / parsed.perServing;
    }
    if (item.servings != null) {
      const s = parseFloat(String(item.servings));
      return Number.isFinite(s) ? s : NaN;
    }
    if (item.amount != null) {
      const s = parseFloat(String(item.amount));
      return Number.isFinite(s) ? s : NaN;
    }
    return NaN;
  };

  const normalizeFood = (foodLike) => ({
    ...foodLike,
    calories: parseFloat(foodLike.calories) || 0,
    protein: parseFloat(foodLike.protein) || 0,
    carbs: parseFloat(foodLike.carbs) || 0,
    fats: parseFloat(foodLike.fats) || 0,
    sugar: parseFloat(foodLike.sugar) || 0,
    addedSugar: parseFloat(foodLike.addedSugar) || 0,
    sodium: parseFloat(foodLike.sodium) || 0,
    fiber: parseFloat(foodLike.fiber) || 0,
  });

  const buildMealRowFromFood = (food, servingsEq, date, mealType, recipeMeta, mode, amount) => ({
    id: Date.now() + Math.floor(Math.random() * 100000),
    date,
    mealType,
    enabled: true,
    foodId: food.id,
    foodName: food.name,
    amountLabel: mode === 'amount' ? extractServingAmount(food.servingSize)?.label || '' : '',
    mode: mode || 'servings',
    amount: Number.isFinite(Number(amount)) ? Number(amount) : servingsEq,
    servings: servingsEq,
    ...recipeMeta,
    calories: (food.calories || 0) * servingsEq,
    protein: (food.protein || 0) * servingsEq,
    carbs: (food.carbs || 0) * servingsEq,
    fats: (food.fats || 0) * servingsEq,
    sugar: (food.sugar || 0) * servingsEq,
    addedSugar: (food.addedSugar || 0) * servingsEq,
    sodium: (food.sodium || 0) * servingsEq,
    fiber: (food.fiber || 0) * servingsEq,
  });

  // ─── Firestore helpers ────────────────────────────────────────────────────
  const foodsCol = (fId) => collection(db, 'families', fId, 'foods');
  const mealsCol = (fId) => collection(db, 'families', fId, 'meals');
  const recipesCol = (fId) => collection(db, 'families', fId, 'recipes');
  const membersCol = (fId) => collection(db, 'families', fId, 'members');

  // ─── Profile setup ────────────────────────────────────────────────────────
  const handleCreateFamily = async () => {
    const name = setupName.trim();
    if (!name) { Alert.alert('Name required', 'Please enter your name.'); return; }
    setSetupLoading(true);
    try {
      const newFamilyId = generateId(6);
      const newUserId = `${Date.now()}_${generateId(4)}`;
      const profile = { userId: newUserId, familyId: newFamilyId, userName: name };
      await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      await setDoc(doc(membersCol(newFamilyId), newUserId), {
        userId: newUserId, name, joinedAt: Date.now(),
      });
      setUserId(newUserId);
      setFamilyId(newFamilyId);
      setUserName(name);
      setViewingUserId(newUserId);
      setShowSetup(false);
    } catch (e) {
      Alert.alert('Error', 'Could not create family. Check your Firebase config.');
      console.error(e);
    } finally {
      setSetupLoading(false);
    }
  };

  const handleJoinFamily = async () => {
    const name = setupName.trim();
    const code = setupCode.trim().toUpperCase();
    if (!name) { Alert.alert('Name required', 'Please enter your name.'); return; }
    if (code.length < 4) { Alert.alert('Code required', 'Enter the family code shared with you.'); return; }
    setSetupLoading(true);
    try {
      const newUserId = `${Date.now()}_${generateId(4)}`;
      const profile = { userId: newUserId, familyId: code, userName: name };
      await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      await setDoc(doc(membersCol(code), newUserId), {
        userId: newUserId, name, joinedAt: Date.now(),
      });
      setUserId(newUserId);
      setFamilyId(code);
      setUserName(name);
      setViewingUserId(newUserId);
      setShowSetup(false);
    } catch (e) {
      Alert.alert('Error', 'Could not join family. Check the code and your Firebase config.');
      console.error(e);
    } finally {
      setSetupLoading(false);
    }
  };

  // ─── Load profile + subscribe to Firestore ────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PROFILE_KEY);
        const profile = safeJsonParse(raw, null);
        if (!profile?.userId || !profile?.familyId) {
          setShowSetup(true);
          setHydrated(true);
          return;
        }
        setUserId(profile.userId);
        setFamilyId(profile.familyId);
        setUserName(profile.userName || '');
        setViewingUserId(profile.userId);
      } catch (e) {
        console.error('Profile load error:', e);
        setShowSetup(true);
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  // Subscribe to Firestore collections once we have a familyId
  useEffect(() => {
    if (!familyId) return;

    const unsubFoods = onSnapshot(foodsCol(familyId), (snap) => {
      const docs = snap.docs.map(d => ({ ...d.data() }));
      docs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setFoods(docs);
    });

    const unsubMeals = onSnapshot(mealsCol(familyId), (snap) => {
      setAllMeals(snap.docs.map(d => ({ ...d.data() })));
    });

    const unsubRecipes = onSnapshot(recipesCol(familyId), (snap) => {
      setAllRecipes(snap.docs.map(d => ({ ...d.data() })));
    });

    const unsubMembers = onSnapshot(membersCol(familyId), (snap) => {
      const members = snap.docs.map(d => ({ ...d.data() }));
      setFamilyMembers(members);
      const me = members.find(m => m.userId === userIdRef.current);
      if (me?.targets) setUserTargets(t => ({ ...DEFAULT_TARGETS, ...me.targets }));
    });

    return () => { unsubFoods(); unsubMeals(); unsubRecipes(); unsubMembers(); };
  }, [familyId]);

  // ─── Food handlers ────────────────────────────────────────────────────────
  const resetNewFood = () => setNewFood({
    name: '', servingSize: '', calories: '', protein: '',
    carbs: '', fats: '', sugar: '', addedSugar: '', sodium: '', fiber: '',
    oncePerDay: false,
  });

  const handleAddFood = async () => {
    if (actionGuard.current) return;
    if (!newFood.name || newFood.calories === '') return;
    actionGuard.current = true;
    const food = normalizeFood({ id: Date.now(), ...newFood });
    // Optimistic: update UI immediately, write in background
    setFoods(prev => [...prev, food].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    resetNewFood();
    setShowAddFood(false);
    try {
      await setDoc(doc(foodsCol(familyId), String(food.id)), food);
    } catch (e) {
      setFoods(prev => prev.filter(f => f.id !== food.id));
      Alert.alert('Error', 'Could not save food.');
    } finally {
      actionGuard.current = false;
    }
  };

  const handleUpdateFood = useCallback(async (ef) => {
    if (!ef?.name?.trim()) return;
    if (actionGuard.current) return;
    actionGuard.current = true;
    const updatedFood = normalizeFood(ef);
    const fid = familyIdRef.current;

    // Optimistic: close edit and update local state immediately.
    // Recipe-logged meals are intentional snapshots — skip them so varied
    // per-day amounts aren't retroactively overwritten by food library edits.
    setEditingFood(null);
    setFoods(prev => prev.map(f => f.id === updatedFood.id ? updatedFood : f));
    setAllMeals(prev => prev.map(m => {
      if (m.foodId !== updatedFood.id || m.fromRecipe) return m;
      const sv = Number(m.servings);
      return {
        ...m,
        foodName: updatedFood.name,
        calories: (updatedFood.calories || 0) * sv,
        protein: (updatedFood.protein || 0) * sv,
        carbs: (updatedFood.carbs || 0) * sv,
        fats: (updatedFood.fats || 0) * sv,
        sugar: (updatedFood.sugar || 0) * sv,
        addedSugar: (updatedFood.addedSugar || 0) * sv,
        sodium: (updatedFood.sodium || 0) * sv,
        fiber: (updatedFood.fiber || 0) * sv,
      };
    }));

    try {
      await setDoc(doc(foodsCol(fid), String(updatedFood.id)), updatedFood);
      // Only cascade to standalone food meals, not recipe snapshots
      const affected = allMealsRef.current.filter(m => m.foodId === updatedFood.id && !m.fromRecipe);
      await Promise.all(affected.map(m => {
        const sv = Number(m.servings);
        return setDoc(doc(mealsCol(fid), String(m.id)), {
          ...m,
          foodName: updatedFood.name,
          calories: (updatedFood.calories || 0) * sv,
          protein: (updatedFood.protein || 0) * sv,
          carbs: (updatedFood.carbs || 0) * sv,
          fats: (updatedFood.fats || 0) * sv,
          sugar: (updatedFood.sugar || 0) * sv,
          addedSugar: (updatedFood.addedSugar || 0) * sv,
          sodium: (updatedFood.sodium || 0) * sv,
          fiber: (updatedFood.fiber || 0) * sv,
        });
      }));
    } catch (e) {
      Alert.alert('Error', 'Could not update food — changes will revert.');
      // onSnapshot will restore the original data automatically on next sync
    } finally {
      actionGuard.current = false;
    }
  }, []); // stable — uses refs for familyId/allMeals, setters are stable

  const handleDeleteFood = useCallback(async (id) => {
    const fid = familyIdRef.current;
    const removedMeals = allMealsRef.current.filter(m => m.foodId === id);
    // Optimistic: remove from local state immediately
    setFoods(prev => prev.filter(f => f.id !== id));
    setAllMeals(prev => prev.filter(m => m.foodId !== id));
    try {
      await deleteDoc(doc(foodsCol(fid), String(id)));
      await Promise.all(removedMeals.map(m => deleteDoc(doc(mealsCol(fid), String(m.id)))));
    } catch (e) {
      Alert.alert('Error', 'Could not delete food — it will reappear.');
      // onSnapshot will restore on next sync
    }
  }, []); // stable — reads from refs, setters are stable

  // ─── Meal handlers ────────────────────────────────────────────────────────
  const handleAddMeal = async () => {
    if (actionGuard.current) return;
    if (!selectedFoodId) return;
    const food = foods.find(f => f.id === Number(selectedFoodId));
    if (!food) return;

    if (mealInputMode === 'amount') {
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed) {
        Alert.alert('Amount not supported', "This food’s serving size must look like \"240 ml\", \"30 g\", \"1 cup\". Log by servings instead.");
        return;
      }
    }

    const servingsEq = toServingsFromInput(food, mealInputMode, mealAmount);
    if (!Number.isFinite(servingsEq) || servingsEq <= 0) return;
    const amountNum = parseFloat(String(mealAmount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) return;

    const parsedAmount = mealInputMode === 'amount' ? extractServingAmount(food.servingSize) : null;
    const meal = {
      id: Date.now(),
      userId,
      userName,
      date: selectedDate,
      mealType,
      enabled: true,
      foodId: food.id,
      foodName: food.name,
      mode: mealInputMode,
      amount: amountNum,
      amountLabel: mealInputMode === 'amount' ? parsedAmount?.label || '' : '',
      servings: servingsEq,
      calories: (food.calories || 0) * servingsEq,
      protein: (food.protein || 0) * servingsEq,
      carbs: (food.carbs || 0) * servingsEq,
      fats: (food.fats || 0) * servingsEq,
      sugar: (food.sugar || 0) * servingsEq,
      addedSugar: (food.addedSugar || 0) * servingsEq,
      sodium: (food.sodium || 0) * servingsEq,
      fiber: (food.fiber || 0) * servingsEq,
    };

    // ── Local-first: show instantly, sync to Firestore in background ──
    setAllMeals(prev => [...prev, meal]);
    setShowAddMeal(false);
    setSelectedFoodId('');
    setMealInputMode('servings');
    setMealAmount('1');
    setFoodSearch('');
    actionGuard.current = true;
    try {
      await setDoc(doc(mealsCol(familyId), String(meal.id)), meal);
    } catch (e) {
      setAllMeals(prev => prev.filter(m => m.id !== meal.id));
      Alert.alert('Error', 'Could not log meal. Check your connection.');
    } finally {
      actionGuard.current = false;
    }
  };

  const handleDeleteMeal = async (id) => {
    const mealToDelete = allMeals.find(m => m.id === id);
    setAllMeals(prev => prev.filter(m => m.id !== id)); // optimistic
    try { await deleteDoc(doc(mealsCol(familyId), String(id))); }
    catch (e) {
      if (mealToDelete) setAllMeals(prev => [...prev, mealToDelete]); // revert
      Alert.alert('Error', 'Could not delete meal.');
    }
  };

  // Delete all meals belonging to a single recipe instance (logged as a group)
  const handleDeleteRecipeInstance = async (instanceId) => {
    // recipeInstanceId is stored as a number; group.instanceId is stringified — coerce both sides
    const instMeals = allMeals.filter(m => String(m.recipeInstanceId) === String(instanceId));
    if (!instMeals.length) return;
    const instIds = new Set(instMeals.map(m => m.id));
    setAllMeals(prev => prev.filter(m => !instIds.has(m.id)));
    try {
      await Promise.all(instMeals.map(m => deleteDoc(doc(mealsCol(familyId), String(m.id)))));
    } catch (e) {
      setAllMeals(prev => [...prev, ...instMeals]); // revert
      Alert.alert('Error', 'Could not delete recipe entry.');
    }
  };

  const handleBulkTransfer = async () => {
    // Use state directly — this function is recreated every render so closures are fresh.
    const targetMember = bulkTargetUserId
      ? familyMembers.find(m => m.userId === bulkTargetUserId)
      : null;
    const crossUser = targetMember && targetMember.userId !== userId;

    const sourceMeals = allMeals.filter(m =>
      m.userId === userId &&
      m.date === selectedDate &&
      (bulkSource === 'day' || m.mealType === bulkSource)
    );
    if (sourceMeals.length === 0) {
      Alert.alert('Nothing to transfer', `No meals found for "${bulkSource === 'day' ? 'entire day' : bulkSource}" on ${selectedDate}.`);
      return;
    }
    const targetDate = bulkTargetDate || selectedDate;
    // Cross-user transfers are always copies — you can't "move" a meal to someone else
    const isCopy = bulkAction === 'copy' || crossUser;
    const baseId = Date.now();

    // Build new meal objects
    const newMeals = sourceMeals.map((m, i) => ({
      ...m,
      id: isCopy ? baseId + i : m.id,
      date: targetDate,
      mealType: bulkTargetType || m.mealType,
      // Cross-user: reassign ownership; stamp new recipeInstanceId so recipe
      // groups are independent in the recipient's log
      ...(crossUser ? {
        userId: targetMember.userId,
        userName: targetMember.name,
        recipeInstanceId: m.recipeInstanceId ? baseId + m.recipeInstanceId : undefined,
      } : {}),
    }));

    // Optimistic update
    if (isCopy) {
      setAllMeals(prev => [...prev, ...newMeals]);
    } else {
      const oldIds = new Set(sourceMeals.map(m => m.id));
      setAllMeals(prev => [...prev.filter(m => !oldIds.has(m.id)), ...newMeals]);
    }
    setShowBulkTransfer(false);

    try {
      await Promise.all(newMeals.map(m => setDoc(doc(mealsCol(familyId), String(m.id)), m)));
    } catch (e) {
      // Revert
      if (isCopy) {
        const newIds = new Set(newMeals.map(m => m.id));
        setAllMeals(prev => prev.filter(m => !newIds.has(m.id)));
      } else {
        setAllMeals(prev => {
          const newIds = new Set(newMeals.map(m => m.id));
          return [...prev.filter(m => !newIds.has(m.id)), ...sourceMeals];
        });
      }
      Alert.alert('Error', 'Transfer failed. Check your connection.');
    }
  };

  const toggleMealEnabled = async (mealId) => {
    const m = allMeals.find(x => x.id === mealId);
    if (!m) return;
    try { await updateDoc(doc(mealsCol(familyId), String(mealId)), { enabled: !(m.enabled ?? true) }); }
    catch (e) { Alert.alert('Error', 'Could not update meal.'); }
  };

  const isValidYYYYMMDD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const shiftSwapDate = (days) => {
    const base = (swapDate || selectedDate) + 'T00:00:00';
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    setSwapDate(d.toISOString().split('T')[0]);
  };

  const saveSwapChanges = async () => {
    if (!swapMeal) return;
    const newMealType = swapMealType || swapMeal.mealType;
    const finalDate = swapDate || swapMeal.date;
    const food = foods.find(f => f.id === swapMeal.foodId);
    if (!food) { Alert.alert('Food not found'); return; }

    const mode = swapMode;
    const amountNum = parseFloat(String(swapServings));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      Alert.alert('Invalid amount', 'Amount must be positive.'); return;
    }
    if (!isValidYYYYMMDD(finalDate)) { Alert.alert('Invalid date', 'Use YYYY-MM-DD.'); return; }

    const servingsEq = toServingsFromInput(food, mode, amountNum);
    if (!Number.isFinite(servingsEq) || servingsEq <= 0) { Alert.alert('Invalid amount'); return; }

    try {
      await setDoc(doc(mealsCol(familyId), String(swapMeal.id)), {
        ...swapMeal,
        mealType: newMealType,
        date: finalDate,
        amountLabel: mode === 'amount' ? extractServingAmount(food.servingSize)?.label || '' : '',
        mode,
        amount: amountNum,
        servings: servingsEq,
        calories: (food.calories || 0) * servingsEq,
        protein: (food.protein || 0) * servingsEq,
        carbs: (food.carbs || 0) * servingsEq,
        fats: (food.fats || 0) * servingsEq,
        sugar: (food.sugar || 0) * servingsEq,
        addedSugar: (food.addedSugar || 0) * servingsEq,
        sodium: (food.sodium || 0) * servingsEq,
        fiber: (food.fiber || 0) * servingsEq,
      });
      setSwapMeal(null);
      setSwapDate('');
      setSwapServings('');
    } catch (e) { Alert.alert('Error', 'Could not update meal.'); }
  };

  // ─── Recipe handlers ──────────────────────────────────────────────────────
  const startRecipeDraft = (recipeId) => {
    const recipe = recipes.find(r => r.id === Number(recipeId));
    if (!recipe) return;
    setSelectedRecipeId(String(recipe.id));
    setRecipePortionsEaten('1');
    setRecipeSearch('');
    setRecipeLogMode('portions');
    setRecipeLoggedWeight('');
    setRecipeDraftItems(
      recipe.items.map(it => ({
        foodId: it.foodId,
        mode: it.mode || 'servings',
        amount: Number.isFinite(Number(it.amount)) ? Number(it.amount) : Number(it.servings ?? 1),
      }))
    );
  };

  const handleLogRecipe = async () => {
    if (!selectedRecipeId) return;
    const recipe = recipes.find(r => r.id === Number(selectedRecipeId));
    if (!recipe) return;

    let portionFactor = NaN;
    if (recipeLogMode === 'weight') {
      const loggedWeightNum = parseFloat(recipeLoggedWeight);
      const finalWeightNum = Number(recipe.finalWeight);
      if (!Number.isFinite(loggedWeightNum) || loggedWeightNum <= 0) return;
      if (!Number.isFinite(finalWeightNum) || finalWeightNum <= 0) {
        Alert.alert('Recipe weight not available', 'This recipe does not have a final weight saved.');
        return;
      }
      portionFactor = loggedWeightNum / finalWeightNum;
    } else {
      const yieldNum = Number(recipe.yield ?? 1);
      const eatenNum = parseFloat(recipePortionsEaten);
      if (!Number.isFinite(eatenNum) || eatenNum <= 0) return;
      if (!Number.isFinite(yieldNum) || yieldNum <= 0) return;
      portionFactor = eatenNum / yieldNum;
    }

    if (!Number.isFinite(portionFactor) || portionFactor <= 0) return;

    const recipeInstanceId = Date.now();
    const recipeMeta = {
      fromRecipe: true,
      recipeId: recipe.id,
      recipeName: recipe.name,
      recipeInstanceId,
      recipeYield: Number(recipe.yield ?? 1),
      recipePortionsEaten: recipeLogMode === 'portions' ? parseFloat(recipePortionsEaten) : null,
      loggedRecipeWeight: recipeLogMode === 'weight' ? parseFloat(recipeLoggedWeight) : null,
      recipeFinalWeight: recipeLogMode === 'weight' ? Number(recipe.finalWeight) : null,
      recipeLogMode,
      portionFactor,
    };

    const rows = recipeDraftItems.map(it => {
      const food = foods.find(f => f.id === Number(it.foodId));
      if (!food) return null;
      const servingsEq = toServings(food, it);
      if (!Number.isFinite(servingsEq) || servingsEq <= 0) return null;
      const scaledServingsEq = servingsEq * portionFactor;
      const rawAmt = parseFloat(String(it.amount));
      const scaledAmount = Number.isFinite(rawAmt) ? rawAmt * portionFactor : scaledServingsEq;
      return buildMealRowFromFood(food, scaledServingsEq, selectedDate, mealType, recipeMeta, it.mode, scaledAmount);
    }).filter(Boolean);

    if (rows.length === 0) return;
    if (actionGuard.current) return;
    actionGuard.current = true;

    const mealsToAdd = rows.map(r => ({ ...r, userId, userName }));
    // Optimistic: add to local state + close modal immediately
    setAllMeals(prev => [...prev, ...mealsToAdd]);
    setShowAddMeal(false);
    setSelectedFoodId('');
    setMealInputMode('servings');
    setMealAmount('1');
    setSelectedRecipeId('');
    setRecipeDraftItems([]);
    setRecipePortionsEaten('1');
    setRecipeLogMode('portions');
    setRecipeLoggedWeight('');
    setLogMode('food');
    setFoodSearch('');

    try {
      await Promise.all(mealsToAdd.map(meal =>
        setDoc(doc(mealsCol(familyId), String(meal.id)), meal)
      ));
    } catch (e) {
      const addedIds = new Set(mealsToAdd.map(m => m.id));
      setAllMeals(prev => prev.filter(m => !addedIds.has(m.id)));
      Alert.alert('Error', 'Could not log recipe. Check your connection.');
    } finally {
      actionGuard.current = false;
    }
  };

  const startEditingRecipe = (recipeId) => {
    const r = recipes.find(x => x.id === Number(recipeId));
    if (!r) return;
    setEditingRecipeId(r.id);
    setNewRecipeName(r.name);
    setRecipeYield(String(r.yield ?? 2));
    setNewRecipeItems(
      (r.items || []).map(it => ({
        foodId: it.foodId,
        mode: it.mode || 'servings',
        amount: Number.isFinite(Number(it.amount)) ? Number(it.amount) : Number(it.servings ?? 1),
      }))
    );
    setRecipeFoodPickerId('');
    setRecipeFoodServings('1');
    setRecipeFoodUnits('100');
    setRecipeFinalWeight(String(r.finalWeight ?? ''));
  };

  const confirmDeleteRecipe = (recipeId) => {
    Alert.alert('Delete recipe?', 'This will remove the recipe from your library.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await deleteDoc(doc(recipesCol(familyId), String(recipeId)));
            if (String(recipeId) === selectedRecipeId) {
              setSelectedRecipeId('');
              setRecipeDraftItems([]);
            }
          } catch (e) { Alert.alert('Error', 'Could not delete recipe.'); }
        },
      },
    ]);
  };

  const resetRecipeBuilder = () => {
    setEditingRecipeId(null);
    setNewRecipeName('');
    setNewRecipeItems([]);
    setRecipeFoodPickerId('');
    setRecipeFoodServings('1');
    setRecipeInputMode('servings');
    setRecipeFoodUnits('100');
    setRecipeYield('2');
    setRecipeFinalWeight('');
    setRecipeLogMode('portions');
    setRecipeLoggedWeight('');
    setRecipeIngredientSearch('');
  };

  const addIngredientToBuilder = () => {
    const foodIdNum = Number(recipeFoodPickerId);
    if (!foodIdNum) { Alert.alert('Pick a food', 'Select a food ingredient first.'); return; }
    const food = foods.find(f => f.id === foodIdNum);
    if (!food) return;

    if (recipeInputMode === 'servings') {
      const servingsNum = parseFloat(recipeFoodServings);
      if (!Number.isFinite(servingsNum) || servingsNum <= 0) {
        Alert.alert('Invalid servings', 'Servings must be a positive number.'); return;
      }
      setNewRecipeItems(prev => [...prev, { foodId: foodIdNum, mode: 'servings', amount: servingsNum }]);
    } else {
      const amountNum = parseFloat(recipeFoodUnits);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        Alert.alert('Invalid amount', 'Amount must be a positive number.'); return;
      }
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed) {
        Alert.alert('Amount not supported', "This food's serving size must be measurable. Add by servings instead.");
        return;
      }
      setNewRecipeItems(prev => [...prev, { foodId: foodIdNum, mode: 'amount', amount: amountNum }]);
    }

    setRecipeFoodPickerId('');
    setRecipeFoodServings('1');
    setRecipeFoodUnits('100');
    setRecipeIngredientSearch('');
  };

  const handleSaveRecipe = async () => {
    const name = newRecipeName.trim();
    if (!name) { Alert.alert('Recipe name required'); return; }
    if (newRecipeItems.length === 0) { Alert.alert('No ingredients', 'Add at least one.'); return; }
    const yieldNum = parseFloat(recipeYield);
    if (!Number.isFinite(yieldNum) || yieldNum <= 0) { Alert.alert('Invalid yield'); return; }

    const finalWeightNum = parseFloat(recipeFinalWeight);
    const hasFinalWeight = Number.isFinite(finalWeightNum) && finalWeightNum > 0;

    for (const it of newRecipeItems) {
      const amt = Number(it.amount);
      if (!Number.isFinite(amt) || amt <= 0) { Alert.alert('Invalid amount', 'All amounts must be positive.'); return; }
      if (!foods.some(f => f.id === Number(it.foodId))) { Alert.alert('Missing food'); return; }
      if (it.mode === 'amount') {
        const food = foods.find(f => f.id === Number(it.foodId));
        if (!extractServingAmount(food?.servingSize)) { Alert.alert('Amount not supported'); return; }
      }
    }

    if (actionGuard.current) return;
    actionGuard.current = true;

    const recipeId = editingRecipeId || Date.now();
    const payload = {
      id: recipeId,
      userId,
      userName,
      name,
      yield: yieldNum,
      finalWeight: hasFinalWeight ? finalWeightNum : null,
      items: newRecipeItems.map(it => ({
        foodId: Number(it.foodId),
        mode: it.mode || 'servings',
        amount: Number(it.amount),
      })),
    };

    // Optimistic: update local state + close builder immediately
    setAllRecipes(prev =>
      editingRecipeId
        ? prev.map(r => r.id === recipeId ? payload : r)
        : [...prev, payload]
    );
    setShowRecipeBuilder(false);
    resetRecipeBuilder();

    try {
      await setDoc(doc(recipesCol(familyId), String(recipeId)), payload);
    } catch (e) {
      if (!editingRecipeId) setAllRecipes(prev => prev.filter(r => r.id !== recipeId));
      // For edits, onSnapshot will revert to actual saved state
      Alert.alert('Error', 'Could not save recipe — changes may not have saved.');
    } finally {
      actionGuard.current = false;
    }
  };

  // ─── Firestore sanitizer (removes undefined / NaN — Firestore rejects them) ──
  const sanitize = (obj) => {
    if (obj === null || obj === undefined) return null;
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : null;
    if (typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = sanitize(v);
    }
    return out;
  };

  // ─── Export / Import ──────────────────────────────────────────────────────
  const exportAllData = async () => {
    try {
      const myMeals = allMeals.filter(m => m.userId === userId);
      const myRecipes = allRecipes.filter(r => r.userId === userId);
      const payload = {
        app: 'meal-tracker',
        version: 2,
        exportedAt: new Date().toISOString(),
        userId,
        userName,
        familyId,
        foods,
        meals: myMeals,
        recipes: myRecipes,
      };
      const json = JSON.stringify(payload, null, 2);
      const fileName = `meal-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
      const uri = FileSystem.documentDirectory + fileName;
      await FileSystem.writeAsStringAsync(uri, json);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Export Meal Tracker Data', UTI: 'public.json' });
      } else {
        await Share.share({ message: json });
      }
    } catch (e) { Alert.alert('Export failed', 'Could not export data.'); }
  };

  const importAllData = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
      if (result.canceled) return;
      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);
      const parsed = JSON.parse(content);
      if (!parsed?.foods) { Alert.alert('Invalid file', 'Not a valid backup.'); return; }

      const foodCount = (parsed.foods || []).length;
      const mealCount = (parsed.meals || []).length;
      const recipeCount = (parsed.recipes || []).length;

      Alert.alert(
        'Import data?',
        `Found ${foodCount} food(s), ${mealCount} meal(s), ${recipeCount} recipe(s).\n\nThis will merge foods and replace your meals/recipes.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Import',
            style: 'destructive',
            onPress: () => {
              setTimeout(async () => {
                const fid = familyIdRef.current;
                const uid = userIdRef.current;
                const uname = userNameRef.current;

                if (!fid || !uid) {
                  Alert.alert('Import failed', `Not logged in (familyId=${fid}, userId=${uid}). Please restart the app.`);
                  return;
                }

                const foodsList = parsed.foods || [];
                const mealsList = parsed.meals || [];
                const recipesList = parsed.recipes || [];
                const total = foodsList.length + mealsList.length + recipesList.length;
                let done = 0;

                setImportProgress({ done: 0, total, phase: 'Foods' });

                let foodsOk = 0, mealsOk = 0, recipesOk = 0, errors = 0;
                try {
                  // ── Foods ──
                  for (const f of foodsList) {
                    try {
                      await setDoc(doc(foodsCol(fid), String(f.id)), sanitize(f));
                      foodsOk++;
                    } catch (_) { errors++; }
                    done++;
                    if (done % 10 === 0 || done === foodsList.length)
                      setImportProgress({ done, total, phase: 'Foods' });
                  }

                  // ── Meals ──
                  setImportProgress({ done, total, phase: 'Meals' });
                  const myOldMeals = allMealsRef.current.filter(m => m.userId === uid);
                  for (const m of myOldMeals) {
                    try { await deleteDoc(doc(mealsCol(fid), String(m.id))); } catch (_) {}
                  }
                  let mostRecentDate = null;
                  for (const m of mealsList) {
                    try {
                      await setDoc(doc(mealsCol(fid), String(m.id)), sanitize({ ...m, userId: uid, userName: uname }));
                      mealsOk++;
                      if (!mostRecentDate || m.date > mostRecentDate) mostRecentDate = m.date;
                    } catch (_) { errors++; }
                    done++;
                    if (done % 10 === 0 || mealsOk === mealsList.length)
                      setImportProgress({ done, total, phase: 'Meals' });
                  }

                  // ── Recipes ──
                  setImportProgress({ done, total, phase: 'Recipes' });
                  const myOldRecipes = allRecipesRef.current.filter(r => r.userId === uid);
                  for (const r of myOldRecipes) {
                    try { await deleteDoc(doc(recipesCol(fid), String(r.id))); } catch (_) {}
                  }
                  for (const r of recipesList) {
                    try {
                      await setDoc(doc(recipesCol(fid), String(r.id)), sanitize({ ...r, userId: uid, userName: uname }));
                      recipesOk++;
                    } catch (_) { errors++; }
                    done++;
                    if (done % 5 === 0 || recipesOk === recipesList.length)
                      setImportProgress({ done, total, phase: 'Recipes' });
                  }

                  setImportProgress(null);
                  if (mostRecentDate) setSelectedDate(mostRecentDate);

                  const msg =
                    `✓ ${foodsOk} food(s)  ✓ ${mealsOk} meal(s)  ✓ ${recipesOk} recipe(s)` +
                    (mostRecentDate ? `\n\nJumped to ${mostRecentDate}.` : '') +
                    (errors > 0 ? `\n\n⚠ ${errors} item(s) skipped.` : '');
                  Alert.alert('Import complete', msg);
                } catch (e) {
                  setImportProgress(null);
                  Alert.alert('Import failed', e.message || 'Unexpected error.');
                }
              }, 500);
            },
          },
        ]
      );
    } catch (e) { Alert.alert('Import failed', 'Could not read the file.'); }
  };

  // ─── Computed values ──────────────────────────────────────────────────────
  const getWeekStartMonday = (yyyyMmDd) => {
    const d = new Date(yyyyMmDd + 'T00:00:00');
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d.toISOString().split('T')[0];
  };

  const addDays = (yyyyMmDd, days) => {
    const d = new Date(yyyyMmDd + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const weekStart = getWeekStartMonday(selectedDate);
  const weekEnd = addDays(weekStart, 6);
  const inRange = (dateStr, s, e) => dateStr >= s && dateStr <= e;

  const weekMeals = meals.filter(m => (m.enabled ?? true) && inRange(m.date, weekStart, weekEnd));

  const totals = useMemo(() => {
    const dailyMeals = meals.filter(m => m.date === selectedDate && (m.enabled ?? true));
    return dailyMeals.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0),
        fats: acc.fats + (m.fats || 0),
        sugar: acc.sugar + (m.sugar || 0),
        addedSugar: acc.addedSugar + (m.addedSugar || 0),
        sodium: acc.sodium + (m.sodium || 0),
        fiber: acc.fiber + (m.fiber || 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fats: 0, sugar: 0, addedSugar: 0, sodium: 0, fiber: 0 }
    );
  }, [meals, selectedDate]);

  const getMealsByType = (type) => meals.filter(m => m.date === selectedDate && m.mealType === type);

  const loggedDaysCount = useMemo(() => {
    const days = new Set(weekMeals.map(m => m.date));
    return Math.max(1, days.size);
  }, [weekMeals]);

  const weekTotals = useMemo(() =>
    weekMeals.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0),
        fats: acc.fats + (m.fats || 0),
        sugar: acc.sugar + (m.sugar || 0),
        addedSugar: acc.addedSugar + (m.addedSugar || 0),
        sodium: acc.sodium + (m.sodium || 0),
        fiber: acc.fiber + (m.fiber || 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fats: 0, sugar: 0, addedSugar: 0, sodium: 0, fiber: 0 }
    ), [weekMeals]);

  const weekAvg = useMemo(() => ({
    calories: weekTotals.calories / loggedDaysCount,
    protein: weekTotals.protein / loggedDaysCount,
    carbs: weekTotals.carbs / loggedDaysCount,
    fats: weekTotals.fats / loggedDaysCount,
    sugar: weekTotals.sugar / loggedDaysCount,
    addedSugar: weekTotals.addedSugar / loggedDaysCount,
    sodium: weekTotals.sodium / loggedDaysCount,
    fiber: weekTotals.fiber / loggedDaysCount,
  }), [weekTotals, loggedDaysCount]);

  // ─── Month stats ──────────────────────────────────────────────────────────
  const monthPrefix = selectedDate.substring(0, 7);
  const monthMeals = useMemo(
    () => meals.filter(m => (m.enabled ?? true) && (m.date || '').startsWith(monthPrefix)),
    [meals, monthPrefix]
  );
  const monthLoggedDays = useMemo(
    () => Math.max(1, new Set(monthMeals.map(m => m.date)).size),
    [monthMeals]
  );
  const monthTotals = useMemo(() =>
    monthMeals.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0),
        fats: acc.fats + (m.fats || 0),
        sugar: acc.sugar + (m.sugar || 0),
        addedSugar: acc.addedSugar + (m.addedSugar || 0),
        sodium: acc.sodium + (m.sodium || 0),
        fiber: acc.fiber + (m.fiber || 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fats: 0, sugar: 0, addedSugar: 0, sodium: 0, fiber: 0 }
    ), [monthMeals]);
  const monthAvg = useMemo(() => ({
    calories: monthTotals.calories / monthLoggedDays,
    protein: monthTotals.protein / monthLoggedDays,
    carbs: monthTotals.carbs / monthLoggedDays,
    fats: monthTotals.fats / monthLoggedDays,
    sugar: monthTotals.sugar / monthLoggedDays,
    addedSugar: monthTotals.addedSugar / monthLoggedDays,
    sodium: monthTotals.sodium / monthLoggedDays,
    fiber: monthTotals.fiber / monthLoggedDays,
  }), [monthTotals, monthLoggedDays]);

  // ─── Calendar helpers ─────────────────────────────────────────────────────
  const MONTH_NAMES = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const calYear = parseInt(calendarMonth.substring(0, 4));
  const calMonthNum = parseInt(calendarMonth.substring(5, 7)) - 1; // 0-based
  const mealDates = useMemo(() => new Set(meals.map(m => m.date)), [meals]);
  const todayStr = new Date().toISOString().split('T')[0];

  const getCalendarCells = () => {
    const daysInMonth = new Date(calYear, calMonthNum + 1, 0).getDate();
    const firstDow = new Date(calYear, calMonthNum, 1).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1; // Monday-first
    const cells = Array(offset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  };

  const shiftCalendarMonth = (delta) => {
    const d = new Date(calYear, calMonthNum + delta, 1);
    setCalendarMonth(d.toISOString().substring(0, 7));
  };

  const openCalendar = () => {
    setCalendarMonth(selectedDate.substring(0, 7));
    setShowCalendar(true);
  };

  const changeDate = (days) => {
    const date = new Date(selectedDate + 'T00:00:00');
    date.setDate(date.getDate() + days);
    setSelectedDate(date.toISOString().split('T')[0]);
  };

  // ─── Meal suggestions (split into two memos) ─────────────────────────────
  // Pass 1: build all frequency tables — does NOT depend on selectedDate
  // so navigating dates doesn't re-run the expensive loops
  const _suggestFreqData = useMemo(() => {
    const myMeals = allMeals.filter(m => m.userId === userId && (m.enabled ?? true));

    // Single pass: food freq + recipe freq + per-date DOW grouping for sameDay
    const foodFreq = {};
    const recipeFreq = {};
    const mealsByDow = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

    for (const m of myMeals) {
      // DOW grouping for sameDay tab
      if (m.foodId && m.date) {
        const [y, mo, d] = m.date.split('-').map(Number);
        const dow = (new Date(y, mo - 1, d)).getDay();
        mealsByDow[dow].push(m);
      }
      if (m.foodId && !m.fromRecipe) {
        const k = m.foodId;
        if (!foodFreq[k]) foodFreq[k] = { foodId: m.foodId, foodName: m.foodName, count: 0, lastDate: '', byType: {}, byTypeServings: {}, totalServings: 0 };
        foodFreq[k].count++;
        foodFreq[k].totalServings += m.servings || 1;
        if (m.date > foodFreq[k].lastDate) foodFreq[k].lastDate = m.date;
        foodFreq[k].byType[m.mealType] = (foodFreq[k].byType[m.mealType] || 0) + 1;
        foodFreq[k].byTypeServings[m.mealType] = (foodFreq[k].byTypeServings[m.mealType] || 0) + (m.servings || 1);
      } else if (m.fromRecipe && m.recipeId) {
        const k = m.recipeId;
        if (!recipeFreq[k]) recipeFreq[k] = { recipeId: m.recipeId, recipeName: m.recipeName, count: 0, lastDate: '' };
        recipeFreq[k].count++;
        if (m.date > recipeFreq[k].lastDate) recipeFreq[k].lastDate = m.date;
      }
    }

    const allFoodEntries = Object.values(foodFreq).map(f => ({
      ...f,
      avgServings: f.totalServings / f.count,
      avgServingsByType: Object.fromEntries(
        Object.entries(f.byTypeServings).map(([t, s]) => [t, s / (f.byType[t] || 1)])
      ),
    })).sort((a, b) => b.count - a.count);

    return { allFoodEntries, recipeFreq, mealsByDow, myMeals };
  }, [allMeals, userId]);

  // Pass 2: filter by today — cheap, runs when selectedDate changes
  const suggestions = useMemo(() => {
    const { allFoodEntries, recipeFreq, mealsByDow, myMeals } = _suggestFreqData;

    // Today's filter
    const todayMeals = myMeals.filter(m => m.date === selectedDate);
    const todayFoodIds = new Set(todayMeals.map(m => m.foodId).filter(Boolean));
    const todayNameTokens = todayMeals.flatMap(m => [
      ...nameTokens(m.foodName || ''), ...nameTokens(m.recipeName || ''),
    ]);
    const notBlocked = (foodId, foodName) =>
      !todayFoodIds.has(foodId) && !similarToAny(foodName, todayNameTokens);

    const frequent = allFoodEntries.filter(f => notBlocked(f.foodId, f.foodName)).slice(0, 12);

    const byType = {};
    for (const type of ['breakfast', 'lunch', 'dinner', 'snacks']) {
      byType[type] = allFoodEntries
        .filter(f => f.byType[type] && notBlocked(f.foodId, f.foodName))
        .sort((a, b) => (b.byType[type] || 0) - (a.byType[type] || 0))
        .slice(0, 8);
    }

    const [y, mo, d] = selectedDate.split('-').map(Number);
    const selectedDow = new Date(y, mo - 1, d).getDay();
    const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const sameDayFreq = {};
    for (const m of mealsByDow[selectedDow] || []) {
      if (m.date === selectedDate) continue;
      const k = m.foodId;
      if (!sameDayFreq[k]) sameDayFreq[k] = { foodId: m.foodId, foodName: m.foodName, count: 0, mealType: m.mealType, totalServings: 0 };
      sameDayFreq[k].count++;
      sameDayFreq[k].totalServings += m.servings || 1;
    }
    const sameDay = Object.values(sameDayFreq)
      .filter(f => notBlocked(f.foodId, f.foodName))
      .map(f => ({ ...f, avgServings: f.totalServings / f.count, avgServingsByType: { [f.mealType]: f.totalServings / f.count } }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    const topRecipes = Object.values(recipeFreq)
      .filter(r => !similarToAny(r.recipeName, todayNameTokens))
      .sort((a, b) => b.count - a.count).slice(0, 6);

    return { frequent, byType, sameDay, sameDayName: DOW_NAMES[selectedDow], topRecipes };
  }, [_suggestFreqData, selectedDate]);

  const targetsSet = (userTargets.calories || 0) > 0;

  const saveTargets = async () => {
    const parsed = {};
    for (const [k, v] of Object.entries(draftTargets)) {
      parsed[k] = parseFloat(String(v)) || 0;
    }
    try {
      await updateDoc(doc(membersCol(familyId), userId), { targets: parsed });
      setUserTargets(parsed);
      setShowSetTargets(false);
    } catch (e) { Alert.alert('Error', 'Could not save targets.'); }
  };

  // ─── Fill My Day planner ──────────────────────────────────────────────────
  const fillDayPlan = useMemo(() => {
    if (!targetsSet) return null;
    const myMeals = allMeals.filter(m => m.userId === userId && (m.enabled ?? true));
    const todayMeals = myMeals.filter(m => m.date === selectedDate);

    // What's consumed today
    const consumed = { calories: 0, protein: 0, carbs: 0, fats: 0 };
    for (const m of todayMeals) {
      consumed.calories += m.calories || 0;
      consumed.protein += m.protein || 0;
      consumed.carbs += m.carbs || 0;
      consumed.fats += m.fats || 0;
    }

    // Remaining budget
    const remaining = {
      calories: Math.max(0, (userTargets.calories || 0) - consumed.calories),
      protein: Math.max(0, (userTargets.protein || 0) - consumed.protein),
      carbs: Math.max(0, (userTargets.carbs || 0) - consumed.carbs),
      fats: Math.max(0, (userTargets.fats || 0) - consumed.fats),
    };

    // Per-type consumed today (for per-slot budget)
    const consumedByType = {};
    for (const m of todayMeals) {
      const t = m.mealType;
      if (!consumedByType[t]) consumedByType[t] = { calories: 0, protein: 0 };
      consumedByType[t].calories += m.calories || 0;
      consumedByType[t].protein += m.protein || 0;
    }

    const weights = { breakfast: 0.25, lunch: 0.35, dinner: 0.30, snacks: 0.10 };
    const ALL_TYPES = ['breakfast', 'lunch', 'dinner', 'snacks'];

    // Show suggestions for a slot until its own calorie budget is used up (not just "has any meal").
    // Stop showing everything only when the whole day's calories are met.
    const macrosMet = remaining.calories <= 0;
    const activeTypes = macrosMet ? [] : ALL_TYPES.filter(type => {
      const slotTarget = (userTargets.calories || 0) * (weights[type] || 0.25);
      const slotConsumed = consumedByType[type]?.calories || 0;
      return slotTarget - slotConsumed > 10; // more than 10 cal still needed in this slot
    });

    // Foods already eaten today — exclude by id and by name similarity
    const todayFoodIds = new Set(todayMeals.map(m => m.foodId).filter(Boolean));
    const todayNameTokens = todayMeals.flatMap(m => [
      ...nameTokens(m.foodName || ''),
      ...nameTokens(m.recipeName || ''),
    ]);

    // Build recipe → "once per day" ingredient foodIds map.
    // Only foods explicitly flagged oncePerDay:true count for cross-slot dedup
    // (protein powder, yogurt, etc.) — salt/spices/milk are never flagged so they're ignored.
    const recipeIngMap = {};
    for (const recipe of recipes) {
      const exclusiveIds = new Set();
      for (const it of recipe.items || []) {
        const food = foods.find(f => f.id === Number(it.foodId));
        if (food?.oncePerDay) exclusiveIds.add(Number(it.foodId));
      }
      recipeIngMap[recipe.id] = exclusiveIds;
    }

    // Pre-compute blocked food IDs: today's exact foods + name-similar foods + ingredients of today's recipes
    const uniqueFoodNames = {};
    for (const m of myMeals) {
      if (m.foodId && !m.fromRecipe && !uniqueFoodNames[m.foodId]) uniqueFoodNames[m.foodId] = m.foodName;
    }
    const blockedFoodIds = new Set([
      ...todayFoodIds,
      ...Object.entries(uniqueFoodNames)
        .filter(([, name]) => similarToAny(name, todayNameTokens))
        .map(([id]) => Number(id)),
    ]);
    // Also block every ingredient of recipes already logged today
    const todayRecipeIds = new Set(todayMeals.filter(m => m.fromRecipe && m.recipeId).map(m => m.recipeId));
    for (const rId of todayRecipeIds) {
      const ingIds = recipeIngMap[rId];
      if (ingIds) ingIds.forEach(id => blockedFoodIds.add(id));
    }

    // Single pass over myMeals: build food freq + recipe freq for all types at once
    const freqByType = {};
    const recipeFreqByType = {};
    for (const m of myMeals) {
      const type = m.mealType;
      if (m.foodId && !m.fromRecipe) {
        if (blockedFoodIds.has(m.foodId)) continue;
        if (!freqByType[type]) freqByType[type] = {};
        const k = m.foodId;
        if (!freqByType[type][k]) freqByType[type][k] = { foodId: m.foodId, foodName: m.foodName, count: 0, totalCals: 0, totalProtein: 0, totalServings: 0 };
        freqByType[type][k].count++;
        freqByType[type][k].totalCals += m.calories || 0;
        freqByType[type][k].totalProtein += m.protein || 0;
        freqByType[type][k].totalServings += m.servings || 1;
      } else if (m.fromRecipe && m.recipeId) {
        if (!recipeFreqByType[type]) recipeFreqByType[type] = {};
        const k = m.recipeId;
        if (!recipeFreqByType[type][k]) recipeFreqByType[type][k] = { recipeId: m.recipeId, recipeName: m.recipeName, count: 0, totalCals: 0 };
        recipeFreqByType[type][k].count++;
        recipeFreqByType[type][k].totalCals += m.calories || 0;
      }
    }

    // Index of currently-existing recipes by string id — filters out deleted recipes
    const existingRecipeIds = new Set(recipes.map(r => String(r.id)));

    // Build slots from pre-built freq tables — no more inner loops over myMeals
    // usedFoodIds / usedRecipeIds prevent the same item appearing in multiple slots
    const slots = {};
    const usedFoodIds = new Set();
    const usedRecipeIds = new Set();
    for (const type of activeTypes) {
      // Per-slot remaining: slot's proportional target minus what's already eaten in that slot
      const slotCals = Math.max(0,
        (userTargets.calories || 0) * (weights[type] || 0.25) - (consumedByType[type]?.calories || 0)
      );
      const slotProtein = Math.max(0,
        (userTargets.protein || 0) * (weights[type] || 0.25) - (consumedByType[type]?.protein || 0)
      );

      const candidates = Object.values(freqByType[type] || {})
        .filter(f => !usedFoodIds.has(f.foodId))
        .map(f => {
          const avgCals = f.totalCals / f.count;
          const avgProtein = f.totalProtein / f.count;
          const avgServings = f.totalServings / f.count;
          const calProximity = slotCals > 0 ? Math.max(0, 1 - Math.abs(avgCals - slotCals) / slotCals) : 0;
          const freqScore = Math.min(f.count / 8, 1);
          return { ...f, avgCals, avgProtein, avgServings, score: calProximity * 0.55 + freqScore * 0.45 };
        }).sort((a, b) => b.score - a.score).slice(0, 10); // keep 10 so dismissed items reveal next-best

      // Only mark top-3 as used cross-slot (rest are available as dismiss alternates)
      candidates.slice(0, 3).forEach(c => usedFoodIds.add(c.foodId));

      // Recipe candidates (top 3): exclude deleted/used/blocked
      const topRecipes = Object.values(recipeFreqByType[type] || {})
        .filter(r => {
          if (!existingRecipeIds.has(String(r.recipeId))) return false;
          if (usedRecipeIds.has(r.recipeId)) return false;
          if (similarToAny(r.recipeName, todayNameTokens)) return false;
          const ings = recipeIngMap[r.recipeId] ?? recipeIngMap[Number(r.recipeId)];
          if (ings) {
            for (const fId of ings) {
              if (usedFoodIds.has(fId) || blockedFoodIds.has(fId)) return false;
            }
          }
          return true;
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 3); // 3 recipe alternates per slot

      if (topRecipes[0]) {
        usedRecipeIds.add(topRecipes[0].recipeId);
        const ings = recipeIngMap[topRecipes[0].recipeId];
        if (ings) ings.forEach(id => usedFoodIds.add(id));
      }

      slots[type] = { targetCals: slotCals, targetProtein: slotProtein, candidates, topRecipes };
    }

    const loggedTypes = new Set(todayMeals.map(m => m.mealType));
    return { consumed, remaining, loggedTypes, activeTypes, slots };
  }, [allMeals, userId, selectedDate, userTargets, targetsSet, recipes, foods]);

  const quickLogFood = async (foodId, suggestedType, avgServings) => {
    if (actionGuard.current) return;
    const food = foods.find(f => f.id === Number(foodId));
    if (!food) return;
    const servings = Math.round((avgServings || 1) * 10) / 10;
    const mealTypeToUse = suggestedType || mealType;
    const meal = {
      id: Date.now(),
      userId,
      userName,
      date: selectedDate,
      mealType: mealTypeToUse,
      enabled: true,
      foodId: food.id,
      foodName: food.name,
      mode: 'servings',
      amount: servings,
      amountLabel: '',
      servings,
      calories: (food.calories || 0) * servings,
      protein: (food.protein || 0) * servings,
      carbs: (food.carbs || 0) * servings,
      fats: (food.fats || 0) * servings,
      sugar: (food.sugar || 0) * servings,
      addedSugar: (food.addedSugar || 0) * servings,
      sodium: (food.sodium || 0) * servings,
      fiber: (food.fiber || 0) * servings,
    };
    actionGuard.current = true;
    setAllMeals(prev => [...prev, meal]);
    setShowSuggest(false);
    try {
      await setDoc(doc(mealsCol(familyIdRef.current), String(meal.id)), meal);
    } catch (e) {
      setAllMeals(prev => prev.filter(m => m.id !== meal.id));
      Alert.alert('Error', 'Could not log meal. Check your connection.');
    } finally {
      actionGuard.current = false;
    }
  };

  const quickLogRecipe = async (recipeId, suggestedMealType) => {
    if (actionGuard.current) return;
    // quickLogRecipe is not useCallback'd, so it closes over live `recipes` state directly.
    // Using the ref was causing stale lookups — use `recipes` (current user, always fresh).
    const rid = String(recipeId);
    const recipe = recipes.find(r => String(r.id) === rid);
    if (!recipe || !recipe.items?.length) {
      Alert.alert('Error', 'Recipe not found or has no ingredients.');
      return;
    }
    const mealTypeToUse = suggestedMealType || mealType;
    const yieldCount = Number(recipe.yield ?? 1) || 1;
    const portionFactor = 1 / yieldCount;
    const recipeInstanceId = Date.now();
    const recipeMeta = {
      fromRecipe: true,
      recipeId: recipe.id,
      recipeName: recipe.name,
      recipeInstanceId,
      recipeYield: yieldCount,
      recipePortionsEaten: 1,
      recipeLogMode: 'portions',
      portionFactor,
    };
    const rows = (recipe.items || []).map((it, i) => {
      const food = foods.find(f => f.id === Number(it.foodId));
      if (!food) return null;
      const servingsEq = toServings(food, it);
      if (!Number.isFinite(servingsEq) || servingsEq <= 0) return null;
      const scaledServings = servingsEq * portionFactor;
      return {
        id: recipeInstanceId + i + 1,
        userId,
        userName,
        date: selectedDate,
        mealType: mealTypeToUse,
        enabled: true,
        foodId: food.id,
        foodName: food.name,
        mode: it.mode || 'servings',
        amount: Number(it.amount) * portionFactor,
        amountLabel: it.amountLabel || '',
        servings: scaledServings,
        calories: (food.calories || 0) * scaledServings,
        protein: (food.protein || 0) * scaledServings,
        carbs: (food.carbs || 0) * scaledServings,
        fats: (food.fats || 0) * scaledServings,
        sugar: (food.sugar || 0) * scaledServings,
        addedSugar: (food.addedSugar || 0) * scaledServings,
        sodium: (food.sodium || 0) * scaledServings,
        fiber: (food.fiber || 0) * scaledServings,
        ...recipeMeta,
      };
    }).filter(Boolean);

    if (rows.length === 0) {
      Alert.alert('Error', 'No valid ingredients could be logged.');
      return;
    }
    actionGuard.current = true;
    setAllMeals(prev => [...prev, ...rows]);
    setShowSuggest(false);
    try {
      const fid = familyIdRef.current;
      await Promise.all(rows.map(m => setDoc(doc(mealsCol(fid), String(m.id)), m)));
    } catch (e) {
      const ids = new Set(rows.map(m => m.id));
      setAllMeals(prev => prev.filter(m => !ids.has(m.id)));
      Alert.alert('Error', 'Could not log recipe. Check your connection.');
    } finally {
      actionGuard.current = false;
    }
  };

  const mealTypes = ['breakfast', 'lunch', 'dinner', 'snacks'];

  const filteredFoods = useMemo(() => {
    const q = foodSearch.trim().toLowerCase();
    if (!q) return foods;
    return foods.filter(f =>
      String(f.name || '').toLowerCase().includes(q) ||
      String(f.servingSize || '').toLowerCase().includes(q)
    );
  }, [foods, foodSearch]);

  // Recipe search for the Log Meal modal picker
  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(r =>
      String(r.name || '').toLowerCase().includes(q) ||
      (r.items || []).some(it => {
        const food = foods.find(f => f.id === Number(it.foodId));
        return String(food?.name || '').toLowerCase().includes(q);
      })
    );
  }, [recipeSearch, recipes, foods]);

  // Recipe search for the dashboard Recipe Library (separate state, no interference)
  const filteredRecipesLib = useMemo(() => {
    const q = recipeLibSearch.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(r =>
      String(r.name || '').toLowerCase().includes(q) ||
      (r.items || []).some(it => {
        const food = foods.find(f => f.id === Number(it.foodId));
        return String(food?.name || '').toLowerCase().includes(q);
      })
    );
  }, [recipeLibSearch, recipes, foods]);

  const filteredRecipeFoods = useMemo(() => {
    const q = recipeIngredientSearch.trim().toLowerCase();
    if (!q) return foods;
    return foods.filter(f =>
      String(f.name || '').toLowerCase().includes(q) ||
      String(f.servingSize || '').toLowerCase().includes(q)
    );
  }, [foods, recipeIngredientSearch]);

  const selectedRecipe = recipes.find(r => r.id === Number(selectedRecipeId));
  const selectedRecipeHasWeight = Number.isFinite(Number(selectedRecipe?.finalWeight)) && Number(selectedRecipe?.finalWeight) > 0;

  const selectedFood = foods.find(f => f.id === Number(selectedFoodId));
  const selectedFoodUnit = extractServingUnit(selectedFood?.servingSize)?.unit || 'units';
  const recipeSelectedFood = foods.find(f => f.id === Number(recipeFoodPickerId));
  const recipeSelectedUnit = extractServingUnit(recipeSelectedFood?.servingSize)?.unit || 'units';

  // ─── Render helpers ───────────────────────────────────────────────────────
  // Stable change handler for food edit fields — uses functional setState so no closure over editingFood
  const handleEditingFoodChange = useCallback((field, val) => {
    setEditingFood(prev => prev ? { ...prev, [field]: val } : prev);
  }, []);
  const handleCancelEditFood = useCallback(() => setEditingFood(null), []);

  // renderFoodItem only changes when editingFood changes (to show/hide edit UI)
  // React.memo on FoodItem ensures non-editing rows never re-render
  const renderFoodItem = useCallback(({ item: food }) => (
    <FoodItem
      food={food}
      isEditing={editingFood?.id === food.id}
      editingData={editingFood?.id === food.id ? editingFood : null}
      onStartEdit={setEditingFood}
      onCancel={handleCancelEditFood}
      onSave={handleUpdateFood}
      onChangeField={handleEditingFoodChange}
      onDelete={handleDeleteFood}
    />
  ), [editingFood, handleUpdateFood, handleDeleteFood, handleCancelEditFood, handleEditingFoodChange]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* ── First-launch setup modal ── */}
      <Modal visible={showSetup} animationType="fade" transparent={false}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#f0f9ff' }}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1, justifyContent: 'center', padding: 24 }}
          >
            <Text style={[styles.title, { marginBottom: 8 }]}>Welcome to{'\n'}Meal Tracker</Text>
            <Text style={{ color: '#6b7280', textAlign: 'center', marginBottom: 32 }}>
              Set up your profile to get started
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Your name (e.g. Soham, Mom, Dad)"
              placeholderTextColor="#6b7280"
              value={setupName}
              onChangeText={setSetupName}
              autoFocus
            />

            <View style={[styles.pickerButtons, { marginVertical: 16 }]}>
              <Pressable
                onPress={() => setSetupMode('create')}
                style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, setupMode === 'create' && styles.pickerButtonActive]}
              >
                <Text style={[styles.pickerButtonText, setupMode === 'create' && styles.pickerButtonTextActive]}>
                  Create family
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setSetupMode('join')}
                style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, setupMode === 'join' && styles.pickerButtonActive]}
              >
                <Text style={[styles.pickerButtonText, setupMode === 'join' && styles.pickerButtonTextActive]}>
                  Join family
                </Text>
              </Pressable>
            </View>

            {setupMode === 'join' && (
              <TextInput
                style={[styles.input, { marginBottom: 12 }]}
                placeholder="Family code (e.g. ABC123)"
                placeholderTextColor="#6b7280"
                value={setupCode}
                onChangeText={setSetupCode}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            )}

            {setupMode === 'create' ? (
              <Text style={{ color: '#6b7280', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                You'll get a family code to share with your parents after setup.
              </Text>
            ) : (
              <Text style={{ color: '#6b7280', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>
                Enter the family code your family member shared with you.
              </Text>
            )}

            <Pressable
              onPress={setupMode === 'create' ? handleCreateFamily : handleJoinFamily}
              disabled={setupLoading}
              style={[styles.addButton, { justifyContent: 'center', paddingVertical: 14, opacity: setupLoading ? 0.6 : 1 }]}
            >
              <Text style={styles.addButtonText}>
                {setupLoading ? 'Setting up…' : setupMode === 'create' ? 'Create Family' : 'Join Family'}
              </Text>
            </Pressable>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <FlatList
        data={filteredFoods}
        renderItem={renderFoodItem}
        keyExtractor={item => item.id.toString()}
        contentContainerStyle={styles.pageContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <>
            <Text style={styles.title}>Meal Tracker</Text>

            {/* Family info + export/import + targets */}
            <View style={styles.topActions}>
              <Pressable
                onPress={() => { setDraftTargets({ ...userTargets }); setShowSetTargets(true); }}
                style={[styles.exportButton, { backgroundColor: targetsSet ? '#7c3aed' : '#374151' }]}
              >
                <Ionicons name="fitness-outline" size={18} color="#fff" />
                <Text style={styles.exportButtonText}>{targetsSet ? 'Targets' : 'Set Targets'}</Text>
              </Pressable>
              <Pressable onPress={exportAllData} style={styles.exportButton}>
                <Ionicons name="download-outline" size={18} color="#fff" />
                <Text style={styles.exportButtonText}>Export</Text>
              </Pressable>
              <Pressable onPress={importAllData} style={styles.exportButton}>
                <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                <Text style={styles.exportButtonText}>Import</Text>
              </Pressable>
            </View>

            {/* Family code banner + sync status */}
            {familyId && (
              <View style={styles.familyBanner}>
                <Ionicons name="people-outline" size={16} color="#4f46e5" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.familyBannerText}>
                    Family: <Text style={{ fontWeight: '800' }}>{familyId}</Text>
                    {'  '}·{'  '}You: <Text style={{ fontWeight: '700' }}>{userName}</Text>
                  </Text>
                  <Text style={styles.syncBadgeText}>
                    🟢 Live sync · {foods.length} foods · {allMeals.filter(m => m.userId === userId).length} meals · {allRecipes.filter(r => r.userId === userId).length} recipes
                  </Text>
                </View>
              </View>
            )}

            {/* Family member switcher */}
            {familyMembers.length > 1 && (
              <View style={styles.memberBar}>
                <Text style={styles.memberBarLabel}>Viewing:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                  {familyMembers.map(member => (
                    <Pressable
                      key={member.userId}
                      onPress={() => setViewingUserId(member.userId)}
                      style={[
                        styles.memberChip,
                        viewingUserId === member.userId && styles.memberChipActive,
                      ]}
                    >
                      <Text style={[
                        styles.memberChipText,
                        viewingUserId === member.userId && styles.memberChipTextActive,
                      ]}>
                        {member.name}{member.userId === userId ? ' (you)' : ''}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

            {!isViewingOwn && (
              <View style={styles.viewingBanner}>
                <Ionicons name="eye-outline" size={14} color="#92400e" />
                <Text style={styles.viewingBannerText}>
                  Viewing {familyMembers.find(m => m.userId === viewingUserId)?.name ?? 'family member'}'s log (read-only)
                </Text>
              </View>
            )}

            {/* Daily Summary */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Daily Summary</Text>
                <Pressable onPress={() => setShowStats(true)} style={styles.weeklyButton}>
                  <Ionicons name="stats-chart-outline" size={18} color="#fff" />
                  <Text style={styles.weeklyButtonText}>Stats</Text>
                </Pressable>
              </View>
              {targetsSet ? (
                /* Progress bars view */
                <View style={{ marginTop: 12, gap: 10 }}>
                  {[
                    { label: 'Calories', key: 'calories', unit: '', dec: 0, color: '#f97316' },
                    { label: 'Protein',  key: 'protein',  unit: 'g', dec: 1, color: '#ef4444' },
                    { label: 'Carbs',    key: 'carbs',    unit: 'g', dec: 1, color: '#eab308' },
                    { label: 'Fats',     key: 'fats',     unit: 'g', dec: 1, color: '#a855f7' },
                    { label: 'Fiber',    key: 'fiber',    unit: 'g', dec: 1, color: '#22c55e' },
                    { label: 'Sodium',   key: 'sodium',   unit: 'mg', dec: 0, color: '#3b82f6' },
                    { label: 'Sugar',    key: 'sugar',    unit: 'g', dec: 1, color: '#ec4899' },
                  ].map(({ label, key, unit, dec, color }) => {
                    const val = totals[key] || 0;
                    const target = userTargets[key] || 0;
                    if (target === 0) return null;
                    const pct = Math.min(val / target, 1);
                    const over = val > target;
                    const remaining = target - val;
                    return (
                      <View key={key} style={styles.targetRow}>
                        <Text style={styles.targetLabel}>{label}</Text>
                        <View style={styles.targetBarWrap}>
                          <View style={[styles.targetBarFill, { width: `${pct * 100}%`, backgroundColor: over ? '#ef4444' : color }]} />
                        </View>
                        <View style={styles.targetValues}>
                          <Text style={styles.targetConsumed}>{val.toFixed(dec)}{unit}</Text>
                          <Text style={[styles.targetLeft, over && { color: '#ef4444', fontWeight: '700' }]}>
                            {over ? `+${Math.abs(remaining).toFixed(dec)}${unit} over` : `${remaining.toFixed(dec)}${unit} left`}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                  <Pressable onPress={() => { setDraftTargets({ ...userTargets }); setShowSetTargets(true); }}
                    style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                    <Text style={{ fontSize: 12, color: '#6b7280', textDecorationLine: 'underline' }}>Edit targets</Text>
                  </Pressable>
                </View>
              ) : (
                /* Original macro cards */
                <View style={styles.summaryGrid}>
                  {[
                    ['Calories', totals.calories.toFixed(0), '', '#fed7aa'],
                    ['Protein',  totals.protein.toFixed(1), 'g', '#fecaca'],
                    ['Carbs',    totals.carbs.toFixed(1),   'g', '#fef08a'],
                    ['Fats',     totals.fats.toFixed(1),    'g', '#e9d5ff'],
                    ['Sugar',    totals.sugar.toFixed(1),   'g', '#fbcfe8'],
                    ['Sodium',   totals.sodium.toFixed(0),  'mg','#bfdbfe'],
                    ['Fiber',    totals.fiber.toFixed(0),   'g', '#bfdbfe'],
                    ['Added Sugar', totals.addedSugar.toFixed(0), 'g', '#bfdbfe'],
                  ].map(([label, val, unit, bg]) => (
                    <View key={label} style={[styles.summaryCard, { backgroundColor: bg }]}>
                      <Text style={styles.summaryLabel}>{label}</Text>
                      <Text style={styles.summaryValue}>{val}{unit}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {/* Daily Meals */}
            <View style={styles.section}>
              {/* Row 1: title + action buttons */}
              <View style={[styles.sectionHeader, { marginBottom: 10 }]}>
                <Text style={styles.sectionTitle}>Daily Meals</Text>
                {isViewingOwn && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable
                      onPress={() => { setSuggestTab('frequent'); setShowSuggest(true); }}
                      style={[styles.addButton, { backgroundColor: '#f59e0b' }]}
                      disabled={foods.length === 0}
                    >
                      <Ionicons name="bulb-outline" size={18} color="#fff" />
                      <Text style={styles.addButtonText}>Suggest</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setShowAddMeal(true)}
                      style={[styles.addButton, { backgroundColor: '#10b981' }]}
                      disabled={foods.length === 0}
                    >
                      <Ionicons name="add" size={20} color="#fff" />
                      <Text style={styles.addButtonText}>Log</Text>
                    </Pressable>
                  </View>
                )}
              </View>
              {/* Row 2: date controls + transfer icon */}
              <View style={[styles.dateControls, { marginBottom: 4 }]}>
                <Pressable onPress={() => changeDate(-1)} style={styles.dateButton}>
                  <Ionicons name="chevron-back" size={24} color="#4f46e5" />
                </Pressable>
                <Pressable onPress={openCalendar} style={styles.dateTouchable}>
                  <Ionicons name="calendar-outline" size={14} color="#4f46e5" />
                  <Text style={styles.dateText}>{selectedDate}</Text>
                </Pressable>
                <Pressable onPress={() => changeDate(1)} style={styles.dateButton}>
                  <Ionicons name="chevron-forward" size={24} color="#4f46e5" />
                </Pressable>
                {selectedDate !== todayStr && (
                  <Pressable onPress={() => setSelectedDate(todayStr)} style={styles.todayButton}>
                    <Text style={styles.todayButtonText}>Today</Text>
                  </Pressable>
                )}
                {isViewingOwn && meals.some(m => m.date === selectedDate) && (
                  <Pressable
                    onPress={() => {
                      setBulkSource('day');
                      setBulkAction('move');
                      setBulkTargetDate('');
                      setBulkTargetType('');
                      setBulkTargetUserId('');
                      setShowBulkTransfer(true);
                    }}
                    style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#ede9fe' }}
                  >
                    <Ionicons name="swap-horizontal-outline" size={15} color="#7c3aed" />
                    <Text style={{ fontSize: 12, color: '#7c3aed', fontWeight: '600' }}>Transfer Day</Text>
                  </Pressable>
                )}
              </View>

              {mealTypes.map(type => {
                const typeMeals = getMealsByType(type);
                if (typeMeals.length === 0) return null;
                return (
                  <View key={type} style={styles.mealTypeSection}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 8, marginBottom: 12 }}>
                      <Text style={styles.mealTypeTitle}>{type.charAt(0).toUpperCase() + type.slice(1)}</Text>
                      {isViewingOwn && (
                        <Pressable
                          onPress={() => {
                            setBulkSource(type);
                            setBulkAction('move');
                            setBulkTargetDate('');
                            setBulkTargetType('');
                            setBulkTargetUserId('');
                            setShowBulkTransfer(true);
                          }}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: '#ede9fe' }}
                        >
                          <Ionicons name="swap-horizontal-outline" size={14} color="#7c3aed" />
                          <Text style={{ fontSize: 11, color: '#7c3aed', fontWeight: '600' }}>Transfer</Text>
                        </Pressable>
                      )}
                    </View>
                    {(() => {
                      // Split into standalone foods and recipe instance groups
                      const standalone = typeMeals.filter(m => !m.fromRecipe || !m.recipeInstanceId);
                      const recipeMap = {};
                      typeMeals.filter(m => m.fromRecipe && m.recipeInstanceId).forEach(m => {
                        const key = String(m.recipeInstanceId);
                        if (!recipeMap[key]) recipeMap[key] = { recipeName: m.recipeName, instanceId: key, items: [], totalCal: 0, totalProtein: 0 };
                        recipeMap[key].items.push(m);
                        recipeMap[key].totalCal += Number(m.calories || 0);
                        recipeMap[key].totalProtein += Number(m.protein || 0);
                      });
                      const recipeGroups = Object.values(recipeMap);

                      return (
                        <>
                          {/* ── Recipe instance groups ── */}
                          {recipeGroups.map(group => {
                            const isExpanded = expandedRecipeInstances.has(group.instanceId);
                            return (
                              <View key={group.instanceId} style={{
                                backgroundColor: '#f5f3ff',
                                borderRadius: 8,
                                marginBottom: 8,
                                paddingHorizontal: 12,
                                paddingTop: 12,
                                paddingBottom: isExpanded ? 8 : 12,
                              }}>
                                {/* Recipe header row — expand toggle and delete are siblings, not nested */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                  <Pressable
                                    onPress={() => setExpandedRecipeInstances(prev => {
                                      const next = new Set(prev);
                                      next.has(group.instanceId) ? next.delete(group.instanceId) : next.add(group.instanceId);
                                      return next;
                                    })}
                                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                                  >
                                    <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={16} color="#7c3aed" />
                                    <View style={{ flex: 1 }}>
                                      <Text style={[styles.mealName, { color: '#4f46e5' }]}>📖 {group.recipeName}</Text>
                                      <Text style={styles.mealDetails}>
                                        {group.totalCal.toFixed(0)} cal · {group.totalProtein.toFixed(1)}g protein · {group.items.length} ingredients
                                      </Text>
                                    </View>
                                  </Pressable>
                                  {isViewingOwn && (
                                    <Pressable onPress={() => handleDeleteRecipeInstance(group.instanceId)} style={styles.iconButton}>
                                      <Ionicons name="trash-outline" size={20} color="#ef4444" />
                                    </Pressable>
                                  )}
                                </View>

                                {/* Expanded ingredient rows */}
                                {isExpanded && (
                                  <View style={{ marginTop: 10, paddingLeft: 24, borderTopWidth: 1, borderTopColor: '#ede9fe', paddingTop: 8 }}>
                                    {group.items.map(meal => {
                                      const displayMode = meal.mode || 'servings';
                                      const displayAmount = meal.amount != null ? meal.amount : (meal.servings ?? 0);
                                      return (
                                        <View key={meal.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5 }}>
                                          <View style={{ flex: 1 }}>
                                            <Text style={{ fontSize: 14, color: '#374151', fontWeight: '500' }}>{meal.foodName}</Text>
                                            <Text style={styles.mealDetails}>
                                              {displayMode === 'amount'
                                                ? `${displayAmount.toFixed(0)} ${expandUnit(meal.amountLabel) || 'units'}`
                                                : `${displayAmount.toFixed(1)} serving(s)`
                                              } · {Number(meal.calories || 0).toFixed(0)} cal
                                            </Text>
                                          </View>
                                          {isViewingOwn && (
                                            <View style={styles.mealActions}>
                                              <Pressable
                                                onPress={() => { setSwapMeal(meal); setSwapDate(meal.date); setSwapServings(String(meal.amount ?? meal.servings)); setSwapMode(meal.mode || 'servings'); setSwapMealType(meal.mealType || 'breakfast'); }}
                                                style={styles.iconButton}
                                              >
                                                <Ionicons name="pencil-outline" size={18} color="#4f46e5" />
                                              </Pressable>
                                              <Pressable onPress={() => handleDeleteMeal(meal.id)} style={styles.iconButton}>
                                                <Ionicons name="trash-outline" size={18} color="#ef4444" />
                                              </Pressable>
                                            </View>
                                          )}
                                        </View>
                                      );
                                    })}
                                  </View>
                                )}
                              </View>
                            );
                          })}

                          {/* ── Standalone food meals ── */}
                          {standalone.map(meal => {
                            const displayMode = meal.mode || 'servings';
                            const displayAmount = meal.amount != null ? meal.amount : (meal.servings ?? 0);
                            return (
                              <View key={meal.id} style={[styles.mealItem, !(meal.enabled ?? true) && styles.mealItemDisabled]}>
                                <View style={styles.mealInfo}>
                                  <Text style={styles.mealName}>{meal.foodName}</Text>
                                  <Text style={styles.mealDetails}>
                                    {displayMode === 'amount'
                                      ? `${displayAmount.toFixed(0)} ${expandUnit(meal.amountLabel) || 'units'}`
                                      : `${displayAmount.toFixed(1)} serving(s)`
                                    }{' '}- {Number(meal.calories || 0).toFixed(0)} cal
                                  </Text>
                                </View>
                                {isViewingOwn && (
                                  <View style={styles.mealActions}>
                                    <Pressable
                                      onPress={() => { setSwapMeal(meal); setSwapDate(meal.date); setSwapServings(String(meal.amount ?? meal.servings)); setSwapMode(meal.mode || 'servings'); setSwapMealType(meal.mealType || 'breakfast'); }}
                                      style={styles.iconButton}
                                    >
                                      <Ionicons name="pencil-outline" size={20} color="#4f46e5" />
                                    </Pressable>
                                    <Pressable onPress={() => toggleMealEnabled(meal.id)} style={styles.iconButton}>
                                      <Ionicons
                                        name={(meal.enabled ?? true) ? 'eye-off-outline' : 'eye-outline'}
                                        size={20}
                                        color={(meal.enabled ?? true) ? '#6b7280' : '#10b981'}
                                      />
                                    </Pressable>
                                    <Pressable onPress={() => handleDeleteMeal(meal.id)} style={styles.iconButton}>
                                      <Ionicons name="trash-outline" size={20} color="#ef4444" />
                                    </Pressable>
                                  </View>
                                )}
                              </View>
                            );
                          })}
                        </>
                      );
                    })()}
                  </View>
                );
              })}

              {meals.filter(m => m.date === selectedDate).length === 0 && (
                <Text style={styles.emptyText}>No meals logged for this date yet.</Text>
              )}
            </View>

            {/* Recipe Library — only shown when viewing own profile */}
            {isViewingOwn && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Recipe Library</Text>
                  <Pressable
                    onPress={() => { setShowRecipeBuilder(true); resetRecipeBuilder(); }}
                    style={styles.addButton}
                    disabled={foods.length === 0}
                  >
                    <Ionicons name="add" size={20} color="#fff" />
                    <Text style={styles.addButtonText}>Add Recipe</Text>
                  </Pressable>
                </View>

                {foods.length === 0 ? (
                  <Text style={styles.emptyText}>Add at least one food first.</Text>
                ) : recipes.length === 0 ? (
                  <Text style={styles.emptyText}>No recipes yet — create your first one.</Text>
                ) : (
                  <View style={{ gap: 10 }}>
                    <View style={styles.searchBar}>
                      <Ionicons name="search-outline" size={16} color="#9ca3af" />
                      <TextInput
                        style={styles.searchInput}
                        placeholder="Search recipes…"
                        placeholderTextColor="#9ca3af"
                        value={recipeLibSearch}
                        onChangeText={setRecipeLibSearch}
                        clearButtonMode="while-editing"
                      />
                    </View>
                    {filteredRecipesLib.length === 0 && (
                      <Text style={styles.emptyText}>No recipes match "{recipeLibSearch}"</Text>
                    )}
                    {filteredRecipesLib.map(r => (
                      <View key={r.id} style={styles.recipeCard}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.recipeName}>{r.name}</Text>
                          <Text style={styles.recipeMeta}>
                            {r.items?.length ?? 0} ingredient(s)
                            {Number.isFinite(Number(r.finalWeight)) && Number(r.finalWeight) > 0
                              ? ` • ${r.finalWeight} g total` : ''}
                            {r.userId !== userId && r.userName
                              ? ` • by ${r.userName}` : ''}
                          </Text>
                        </View>
                        {r.userId === userId && (
                          <View style={styles.mealActions}>
                            <Pressable onPress={() => { setShowRecipeBuilder(true); startEditingRecipe(r.id); }} style={styles.iconButton}>
                              <Ionicons name="pencil-outline" size={20} color="#4f46e5" />
                            </Pressable>
                            <Pressable onPress={() => confirmDeleteRecipe(r.id)} style={styles.iconButton}>
                              <Ionicons name="trash-outline" size={20} color="#ef4444" />
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Food Library */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Food Library</Text>
                <Pressable onPress={() => setShowAddFood(true)} style={styles.addButton}>
                  <Ionicons name="add" size={20} color="#fff" />
                  <Text style={styles.addButtonText}>Add Food</Text>
                </Pressable>
              </View>
              {foods.length === 0 ? (
                <Text style={styles.emptyText}>No foods yet — add your first one.</Text>
              ) : (
                <View style={styles.searchBar}>
                  <Ionicons name="search-outline" size={16} color="#9ca3af" />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search foods…"
                    placeholderTextColor="#9ca3af"
                    value={foodSearch}
                    onChangeText={setFoodSearch}
                    clearButtonMode="while-editing"
                  />
                </View>
              )}
              {foods.length > 0 && filteredFoods.length === 0 && (
                <Text style={styles.emptyText}>No foods match "{foodSearch}"</Text>
              )}
            </View>
          </>
        }
        ListFooterComponent={<View style={{ height: 24 }} />}
      />

      {/* ─── Bulk Transfer Modal ─────────────────────────────────────────── */}
      <Modal visible={showBulkTransfer} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Transfer Meals</Text>
              <Pressable onPress={() => setShowBulkTransfer(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>

              {/* Source */}
              <Text style={styles.inputLabel}>Transfer from</Text>
              <View style={[styles.pickerButtons, { flexWrap: 'wrap' }]}>
                {['day', ...mealTypes].map(opt => (
                  <Pressable
                    key={opt}
                    onPress={() => setBulkSource(opt)}
                    style={[styles.pickerButton, bulkSource === opt && styles.pickerButtonActive, { marginBottom: 6 }]}
                  >
                    <Text style={[styles.pickerButtonText, bulkSource === opt && styles.pickerButtonTextActive]}>
                      {opt === 'day' ? 'Entire Day' : opt.charAt(0).toUpperCase() + opt.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Action */}
              <Text style={[styles.inputLabel, { marginTop: 14 }]}>Action</Text>
              <View style={styles.pickerButtons}>
                {[['move', 'Move (remove from source)'], ['copy', 'Copy (keep original)']].map(([val, label]) => (
                  <Pressable
                    key={val}
                    onPress={() => setBulkAction(val)}
                    style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, bulkAction === val && styles.pickerButtonActive]}
                  >
                    <Text style={[styles.pickerButtonText, bulkAction === val && styles.pickerButtonTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Target meal type (optional — only if shifting within day) */}
              <Text style={[styles.inputLabel, { marginTop: 14 }]}>Target meal type <Text style={{ color: '#9ca3af', fontWeight: '400' }}>(optional — leave blank to keep same)</Text></Text>
              <View style={[styles.pickerButtons, { flexWrap: 'wrap' }]}>
                {['', ...mealTypes].map(opt => (
                  <Pressable
                    key={opt || 'same'}
                    onPress={() => setBulkTargetType(opt)}
                    style={[styles.pickerButton, bulkTargetType === opt && styles.pickerButtonActive, { marginBottom: 6 }]}
                  >
                    <Text style={[styles.pickerButtonText, bulkTargetType === opt && styles.pickerButtonTextActive]}>
                      {opt === '' ? 'Same' : opt.charAt(0).toUpperCase() + opt.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Copy to family member */}
              {familyMembers.filter(m => m.userId !== userId).length > 0 && (
                <>
                  <Text style={[styles.inputLabel, { marginTop: 14 }]}>
                    Copy to family member{' '}
                    <Text style={{ color: '#9ca3af', fontWeight: '400' }}>(optional — blank = yourself)</Text>
                  </Text>
                  <View style={[styles.pickerButtons, { flexWrap: 'wrap' }]}>
                    <Pressable
                      key="self"
                      onPress={() => setBulkTargetUserId('')}
                      style={[styles.pickerButton, bulkTargetUserId === '' && styles.pickerButtonActive, { marginBottom: 6 }]}
                    >
                      <Text style={[styles.pickerButtonText, bulkTargetUserId === '' && styles.pickerButtonTextActive]}>
                        Myself
                      </Text>
                    </Pressable>
                    {familyMembers.filter(m => m.userId !== userId).map(member => (
                      <Pressable
                        key={member.userId}
                        onPress={() => setBulkTargetUserId(member.userId)}
                        style={[styles.pickerButton, bulkTargetUserId === member.userId && styles.pickerButtonActive, { marginBottom: 6 }]}
                      >
                        <Text style={[styles.pickerButtonText, bulkTargetUserId === member.userId && styles.pickerButtonTextActive]}>
                          {member.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  {bulkTargetUserId && bulkTargetUserId !== userId && (
                    <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                      ℹ️ Cross-user transfers are always copies — meals will also stay in your log.
                    </Text>
                  )}
                </>
              )}

              {/* Target date (optional — leave blank to keep same day) */}
              <Text style={[styles.inputLabel, { marginTop: 14 }]}>Target date <Text style={{ color: '#9ca3af', fontWeight: '400' }}>(YYYY-MM-DD — leave blank to keep {selectedDate})</Text></Text>
              <TextInput
                style={styles.input}
                value={bulkTargetDate}
                onChangeText={setBulkTargetDate}
                placeholder={selectedDate}
                placeholderTextColor="#9ca3af"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />

              {/* Summary */}
              {(() => {
                const src = bulkSource === 'day' ? `all meals on ${selectedDate}` : `${bulkSource} on ${selectedDate}`;
                const targetName = bulkTargetUserId
                  ? familyMembers.find(m => m.userId === bulkTargetUserId)?.name ?? 'family member'
                  : 'yourself';
                const crossUser = bulkTargetUserId && bulkTargetUserId !== userId;
                return (
                  <View style={{ backgroundColor: '#f3f4f6', borderRadius: 10, padding: 12, marginTop: 16 }}>
                    <Text style={{ color: '#374151', fontSize: 13 }}>
                      <Text style={{ fontWeight: '700' }}>{crossUser ? 'Copy' : (bulkAction === 'move' ? 'Move' : 'Copy')}</Text>{' '}
                      {src} → {bulkTargetDate || selectedDate}
                      {bulkTargetType ? ` (${bulkTargetType})` : ''}
                      {` for ${targetName}`}
                    </Text>
                  </View>
                );
              })()}

              <Pressable
                onPress={handleBulkTransfer}
                style={[styles.addButton, { marginTop: 20, justifyContent: 'center', paddingVertical: 14, backgroundColor: '#6366f1' }]}
              >
                <Ionicons name="swap-horizontal-outline" size={18} color="#fff" />
                <Text style={styles.addButtonText}>
                  {(bulkTargetUserId && bulkTargetUserId !== userId) ? 'Copy to Family Member' : (bulkAction === 'move' ? 'Move Meals' : 'Copy Meals')}
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Unified Stats modal (weekly / monthly) */}
      <Modal visible={showStats} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Stats</Text>
              <Pressable onPress={() => setShowStats(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            {/* Toggle */}
            <View style={[styles.pickerButtons, { marginBottom: 16 }]}>
              {['weekly', 'monthly'].map(tab => (
                <Pressable
                  key={tab}
                  onPress={() => setStatsTab(tab)}
                  style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, statsTab === tab && styles.pickerButtonActive]}
                >
                  <Text style={[styles.pickerButtonText, statsTab === tab && styles.pickerButtonTextActive]}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>

            {statsTab === 'weekly' ? (
              <>
                <Text style={{ color: '#6b7280', marginBottom: 4 }}>{weekStart} → {weekEnd}</Text>
                <Text style={{ color: '#6b7280', marginBottom: 12 }}>Based on {loggedDaysCount} logged day(s)</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={{ fontWeight: '700', color: '#374151', marginBottom: 8 }}>Daily Average</Text>
                  <View style={styles.summaryGrid}>
                    {[
                      ['Calories', weekAvg.calories.toFixed(0), ''],
                      ['Protein', weekAvg.protein.toFixed(1), 'g'],
                      ['Carbs', weekAvg.carbs.toFixed(1), 'g'],
                      ['Fats', weekAvg.fats.toFixed(1), 'g'],
                      ['Sugar', weekAvg.sugar.toFixed(1), 'g'],
                      ['Added Sugar', weekAvg.addedSugar.toFixed(1), 'g'],
                      ['Sodium', weekAvg.sodium.toFixed(0), 'mg'],
                      ['Fiber', weekAvg.fiber.toFixed(1), 'g'],
                    ].map(([label, val, unit]) => (
                      <View key={label} style={styles.weekCard}>
                        <Text style={styles.weekLabel}>{label}</Text>
                        <Text style={styles.weekValue}>{val}{unit}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={{ height: 12 }} />
                </ScrollView>
              </>
            ) : (
              <>
                <Text style={{ color: '#6b7280', marginBottom: 4 }}>
                  {MONTH_NAMES[parseInt(monthPrefix.substring(5)) - 1]} {monthPrefix.substring(0, 4)}
                </Text>
                <Text style={{ color: '#6b7280', marginBottom: 12 }}>
                  {monthLoggedDays} logged day(s) · {monthMeals.length} entries
                </Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={{ fontWeight: '700', color: '#374151', marginBottom: 8 }}>Daily Average</Text>
                  <View style={styles.summaryGrid}>
                    {[
                      ['Calories', monthAvg.calories.toFixed(0), ''],
                      ['Protein', monthAvg.protein.toFixed(1), 'g'],
                      ['Carbs', monthAvg.carbs.toFixed(1), 'g'],
                      ['Fats', monthAvg.fats.toFixed(1), 'g'],
                      ['Sugar', monthAvg.sugar.toFixed(1), 'g'],
                      ['Added Sugar', monthAvg.addedSugar.toFixed(1), 'g'],
                      ['Sodium', monthAvg.sodium.toFixed(0), 'mg'],
                      ['Fiber', monthAvg.fiber.toFixed(1), 'g'],
                    ].map(([label, val, unit]) => (
                      <View key={label} style={styles.weekCard}>
                        <Text style={styles.weekLabel}>{label}</Text>
                        <Text style={styles.weekValue}>{val}{unit}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={{ fontWeight: '700', color: '#374151', marginTop: 16, marginBottom: 8 }}>Month Total</Text>
                  <View style={styles.summaryGrid}>
                    {[
                      ['Calories', monthTotals.calories.toFixed(0), ''],
                      ['Protein', monthTotals.protein.toFixed(1), 'g'],
                      ['Carbs', monthTotals.carbs.toFixed(1), 'g'],
                      ['Fats', monthTotals.fats.toFixed(1), 'g'],
                    ].map(([label, val, unit]) => (
                      <View key={label} style={[styles.weekCard, { backgroundColor: '#f0fdf4' }]}>
                        <Text style={styles.weekLabel}>{label}</Text>
                        <Text style={[styles.weekValue, { color: '#166534' }]}>{val}{unit}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={{ height: 12 }} />
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Add Food Modal */}
      <Modal visible={showAddFood} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add New Food</Text>
              <Pressable onPress={() => setShowAddFood(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {[
                ['Food name *', 'name', 'default'],
                ['Serving size (e.g., 1 cup, 100g)', 'servingSize', 'default'],
                ['Calories *', 'calories', 'numeric'],
                ['Protein (g)', 'protein', 'numeric'],
                ['Carbs (g)', 'carbs', 'numeric'],
                ['Fats (g)', 'fats', 'numeric'],
                ['Sugar (g)', 'sugar', 'numeric'],
                ['Added Sugar (g)', 'addedSugar', 'numeric'],
                ['Sodium (mg)', 'sodium', 'numeric'],
                ['Fiber (g)', 'fiber', 'numeric'],
              ].map(([placeholder, field, kbType]) => (
                <TextInput key={field} style={styles.input}
                  placeholder={placeholder} placeholderTextColor="#6b7280"
                  value={newFood[field]} onChangeText={text => setNewFood({ ...newFood, [field]: text })}
                  keyboardType={kbType} />
              ))}
              <Pressable onPress={handleAddFood} style={[styles.addButton, styles.modalButton]}>
                <Text style={styles.addButtonText}>Add Food</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Log Meal Modal */}
      <Modal visible={showAddMeal} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Log a Meal</Text>
              <Pressable onPress={() => {
                setShowAddMeal(false);
                setSelectedRecipeId('');
                setRecipeSearch('');
                setRecipeDraftItems([]);
                setLogMode('food');
                setRecipePortionsEaten('1');
              }}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

              {/* Log Mode toggle */}
              <View style={styles.pickerContainer}>
                <Text style={styles.pickerLabel}>Log Mode</Text>
                <View style={styles.pickerButtons}>
                  {['food', 'recipe'].map(mode => (
                    <Pressable key={mode} onPress={() => setLogMode(mode)}
                      style={[styles.pickerButton, logMode === mode && styles.pickerButtonActive]}>
                      <Text style={[styles.pickerButtonText, logMode === mode && styles.pickerButtonTextActive]}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.modalForm}>
                {/* Meal type */}
                <View style={styles.pickerContainer}>
                  <Text style={styles.pickerLabel}>Meal Type</Text>
                  <View style={styles.pickerButtons}>
                    {['breakfast', 'lunch', 'dinner', 'snacks'].map(type => (
                      <Pressable key={type} onPress={() => setMealType(type)}
                        style={[styles.pickerButton, mealType === type && styles.pickerButtonActive]}>
                        <Text style={[styles.pickerButtonText, mealType === type && styles.pickerButtonTextActive]}>
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {/* Food mode */}
                {logMode === 'food' && (
                  <>
                    <View style={styles.pickerContainer}>
                      <Text style={styles.pickerLabel}>Select Food</Text>
                      <TextInput style={styles.searchInput} placeholder="Search foods…"
                        placeholderTextColor="#6b7280" value={foodSearch}
                        onChangeText={setFoodSearch} returnKeyType="search" clearButtonMode="while-editing" />
                      <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                        {filteredFoods.map(f => (
                          <Pressable key={f.id} onPress={() => setSelectedFoodId(String(f.id))}
                            style={[styles.foodOption, selectedFoodId === String(f.id) && styles.foodOptionActive]}>
                            <Text style={[styles.foodOptionText, selectedFoodId === String(f.id) && styles.foodOptionTextActive]}>
                              {f.name}{f.servingSize ? ` • ${f.servingSize}` : ''}
                            </Text>
                          </Pressable>
                        ))}
                        {filteredFoods.length === 0 && <Text style={styles.emptySearchText}>No matches</Text>}
                      </ScrollView>
                    </View>

                    <View style={styles.pickerButtons}>
                      {[
                        { val: 'servings', label: 'Servings' },
                        { val: 'amount',   label: selectedFood ? expandUnit(selectedFoodUnit) : 'Grams/Units' },
                      ].map(({ val, label }) => (
                        <Pressable key={val} onPress={() => setMealInputMode(val)}
                          style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, mealInputMode === val && styles.pickerButtonActive]}>
                          <Text style={[styles.pickerButtonText, mealInputMode === val && styles.pickerButtonTextActive]}>
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    <TextInput style={styles.input}
                      placeholder={mealInputMode === 'amount' ? 'Amount (e.g. 58, 240, 5)' : 'Servings (e.g. 1, 0.5)'}
                      placeholderTextColor="#6b7280" value={mealAmount}
                      onChangeText={setMealAmount} keyboardType="decimal-pad"
                      returnKeyType="done" onSubmitEditing={Keyboard.dismiss} />
                  </>
                )}

                {/* Recipe mode */}
                {logMode === 'recipe' && (
                  <>
                    <View style={styles.pickerButtons}>
                      <Pressable onPress={() => setRecipeLogMode('portions')}
                        style={[styles.pickerButton, recipeLogMode === 'portions' && styles.pickerButtonActive]}>
                        <Text style={[styles.pickerButtonText, recipeLogMode === 'portions' && styles.pickerButtonTextActive]}>Portions</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => { if (selectedRecipeHasWeight) setRecipeLogMode('weight'); }}
                        style={[styles.pickerButton, recipeLogMode === 'weight' && styles.pickerButtonActive, !selectedRecipeHasWeight && { opacity: 0.5 }]}>
                        <Text style={[styles.pickerButtonText, recipeLogMode === 'weight' && styles.pickerButtonTextActive]}>Weight</Text>
                      </Pressable>
                    </View>

                    {recipeLogMode === 'weight' ? (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Weight Eaten (g)</Text>
                        <TextInput style={styles.input} placeholder="e.g. 150"
                          value={recipeLoggedWeight} onChangeText={setRecipeLoggedWeight} keyboardType="decimal-pad" />
                      </>
                    ) : (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Portions Eaten</Text>
                        <TextInput style={styles.input} placeholder="e.g. 1.5"
                          value={recipePortionsEaten} onChangeText={setRecipePortionsEaten} keyboardType="decimal-pad" />
                      </>
                    )}

                    <View style={styles.pickerContainer}>
                      <Text style={styles.pickerLabel}>Select Recipe</Text>
                      <TextInput style={styles.searchInput} placeholder="Search recipes…"
                        placeholderTextColor="#6b7280" value={recipeSearch} onChangeText={setRecipeSearch} />
                      <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                        {filteredRecipes.map(r => (
                          <Pressable key={r.id} onPress={() => startRecipeDraft(r.id)}
                            style={[styles.foodOption, selectedRecipeId === String(r.id) && styles.foodOptionActive]}>
                            <Text style={[styles.foodOptionText, selectedRecipeId === String(r.id) && styles.foodOptionTextActive]}>
                              {r.name}
                            </Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </View>

                    {!!selectedRecipeId && (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Ingredients</Text>
                        {recipeDraftItems.map((it, idx) => {
                          const food = foods.find(f => f.id === Number(it.foodId));
                          return (
                            <View key={`${it.foodId}-${idx}`} style={styles.mealItem}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.mealName}>
                                  {food ? food.name : 'Missing food'} • {
                                    it.mode === 'amount'
                                      ? `${it.amount} ${expandUnit(extractServingAmount(food?.servingSize)?.label) || 'units'}`
                                      : `${it.amount} serving(s)`
                                  }
                                </Text>
                                <Text style={styles.recipeMeta}>1 serving = {food?.servingSize || '—'}</Text>
                                <TextInput style={[styles.input, { marginTop: 6 }]}
                                  value={String(it.amount ?? '')}
                                  onChangeText={t => setRecipeDraftItems(prev => prev.map((x, i) => i === idx ? { ...x, amount: t } : x))}
                                  keyboardType="decimal-pad"
                                  placeholder={it.mode === 'amount' ? 'Amount' : 'Servings'}
                                  placeholderTextColor="#6b7280" />
                              </View>
                              <Pressable onPress={() => setRecipeDraftItems(prev => prev.filter((_, i) => i !== idx))} style={styles.iconButton}>
                                <Ionicons name="trash-outline" size={20} color="#ef4444" />
                              </Pressable>
                            </View>
                          );
                        })}
                      </>
                    )}
                  </>
                )}
              </View>
            </ScrollView>

            <View style={styles.modalBottomBar}>
              <Pressable
                onPress={logMode === 'recipe' ? handleLogRecipe : handleAddMeal}
                style={[styles.modalPrimaryButton, { backgroundColor: '#10b981' }]}>
                <Text style={styles.modalPrimaryButtonText}>
                  {logMode === 'recipe' ? 'Log Recipe' : 'Log Meal'}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Recipe Builder Modal */}
      <Modal visible={showRecipeBuilder} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingRecipeId ? 'Edit Recipe' : 'Create Recipe'}</Text>
              <Pressable onPress={() => { setShowRecipeBuilder(false); resetRecipeBuilder(); }}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TextInput style={styles.input} placeholder="Recipe name *"
                placeholderTextColor="#6b7280" value={newRecipeName} onChangeText={setNewRecipeName} />

              <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Add ingredient</Text>

              <View style={{ gap: 10 }}>
                <TextInput style={styles.searchInput} placeholder="Search ingredients…"
                  placeholderTextColor="#6b7280" value={recipeIngredientSearch} onChangeText={setRecipeIngredientSearch} />

                <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                  {filteredRecipeFoods.map(food => (
                    <Pressable key={food.id} onPress={() => setRecipeFoodPickerId(String(food.id))}
                      style={[styles.foodOption, recipeFoodPickerId === String(food.id) && styles.foodOptionActive]}>
                      <Text style={[styles.foodOptionText, recipeFoodPickerId === String(food.id) && styles.foodOptionTextActive]}>
                        {food.name}{food.servingSize ? ` • ${food.servingSize}` : ''}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Yield (portions)</Text>
                <TextInput style={styles.input} placeholder="Yield (portions)"
                  placeholderTextColor="#6b7280" value={recipeYield} onChangeText={setRecipeYield} keyboardType="decimal-pad" />

                <Text style={[styles.pickerLabel, { marginTop: 12 }]}>Final recipe weight</Text>
                <TextInput style={styles.input} placeholder="Final cooked weight (e.g. 580)"
                  placeholderTextColor="#6b7280" value={recipeFinalWeight} onChangeText={setRecipeFinalWeight} keyboardType="decimal-pad" />

                <View style={styles.pickerButtons}>
                  {['servings', 'amount'].map(mode => (
                    <Pressable key={mode} onPress={() => setRecipeInputMode(mode)}
                      style={[styles.pickerButton, recipeInputMode === mode && styles.pickerButtonActive]}>
                      <Text style={[styles.pickerButtonText, recipeInputMode === mode && styles.pickerButtonTextActive]}>
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {recipeInputMode === 'servings' ? (
                  <TextInput style={styles.input} placeholder="Servings (e.g. 1, 0.5)"
                    placeholderTextColor="#6b7280" value={recipeFoodServings} onChangeText={setRecipeFoodServings} keyboardType="decimal-pad" />
                ) : (
                  <TextInput style={styles.input} placeholder={`${recipeSelectedUnit} (e.g. 100)`}
                    placeholderTextColor="#6b7280" value={recipeFoodUnits} onChangeText={setRecipeFoodUnits} keyboardType="decimal-pad" />
                )}

                <Pressable onPress={addIngredientToBuilder} style={[styles.addButton, { justifyContent: 'center' }]}>
                  <Text style={styles.addButtonText}>Add ingredient</Text>
                </Pressable>
              </View>

              {!!newRecipeItems.length && (
                <>
                  <Text style={[styles.pickerLabel, { marginTop: 16 }]}>Ingredients</Text>
                  {newRecipeItems.map((it, idx) => {
                    const food = foods.find(f => f.id === Number(it.foodId));
                    return (
                      <View key={`${it.foodId}-${idx}`} style={styles.mealItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.mealName}>
                            {food ? food.name : 'Missing food'} • {
                              it.mode === 'amount'
                                ? `${it.amount} ${expandUnit(extractServingAmount(food?.servingSize)?.label) || 'units'}`
                                : `${it.amount} serving(s)`
                            }
                          </Text>
                          <Text style={styles.recipeMeta}>1 serving = {food?.servingSize || '—'}</Text>
                          <TextInput style={[styles.input, { marginTop: 6 }]}
                            value={String(it.amount ?? '')}
                            onChangeText={t => setNewRecipeItems(prev => prev.map((x, i) => i === idx ? { ...x, amount: t } : x))}
                            keyboardType="decimal-pad"
                            placeholder={it.mode === 'amount' ? 'Amount' : 'Servings'}
                            placeholderTextColor="#6b7280" />
                        </View>
                        <Pressable onPress={() => setNewRecipeItems(prev => prev.filter((_, i) => i !== idx))} style={styles.iconButton}>
                          <Ionicons name="trash-outline" size={20} color="#ef4444" />
                        </Pressable>
                      </View>
                    );
                  })}
                </>
              )}

              <Pressable onPress={handleSaveRecipe} style={[styles.modalPrimaryButton, { backgroundColor: '#10b981', marginTop: 14 }]}>
                <Text style={styles.modalPrimaryButtonText}>
                  {editingRecipeId ? 'Save Changes' : 'Save Recipe'}
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Meal Suggester modal */}
      <Modal visible={showSuggest} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '88%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>✨ Meal Suggestions</Text>
              <Pressable onPress={() => setShowSuggest(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>
            <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 12 }}>
              Based on your meal history · tap any item to pre-fill the log
            </Text>

            {/* Tabs */}
            <View style={[styles.pickerButtons, { marginBottom: 14 }]}>
              {[
                ['frequent','Frequent'],
                ['bytype','By Meal'],
                ['sameday', suggestions.sameDayName + 's'],
                ...(targetsSet ? [['fillday','Fill Day']] : []),
              ].map(([key, label]) => (
                <Pressable
                  key={key}
                  onPress={() => setSuggestTab(key)}
                  style={[styles.pickerButton, { flex: 1, justifyContent: 'center', paddingHorizontal: 4 },
                    suggestTab === key && (key === 'fillday' ? styles.pickerButtonFillDay : styles.pickerButtonActive)]}
                >
                  <Text style={[styles.pickerButtonText, { textAlign: 'center', fontSize: 11 }, suggestTab === key && styles.pickerButtonTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

              {/* ── FREQUENT tab ── */}
              {suggestTab === 'frequent' && (
                <>
                  {suggestions.frequent.length === 0 ? (
                    <Text style={styles.emptyText}>Log some meals first and suggestions will appear here.</Text>
                  ) : (
                    <>
                      <Text style={styles.suggestSectionLabel}>Your most-logged foods</Text>
                      {suggestions.frequent.map(item => (
                        <View key={item.foodId} style={styles.suggestRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.suggestFoodName}>{item.foodName}</Text>
                            <Text style={styles.suggestMeta}>
                              Logged {item.count}× · last {item.lastDate}
                              {item.byType && Object.entries(item.byType).sort((a,b) => b[1]-a[1])[0]
                                ? ` · usually ${Object.entries(item.byType).sort((a,b) => b[1]-a[1])[0][0]}`
                                : ''}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', gap: 6 }}>
                            {Object.entries(item.byType).sort((a,b) => b[1]-a[1]).slice(0,2).map(([type]) => (
                              <Pressable
                                key={type}
                                onPress={() => quickLogFood(item.foodId, type, item.avgServingsByType?.[type] || item.avgServings)}
                                style={styles.suggestTypeChip}
                              >
                                <Text style={styles.suggestTypeChipText}>{type[0].toUpperCase()}</Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      ))}
                    </>
                  )}

                  {suggestions.topRecipes.length > 0 && (
                    <>
                      <Text style={[styles.suggestSectionLabel, { marginTop: 16 }]}>Your go-to recipes</Text>
                      {suggestions.topRecipes.map(r => (
                        <Pressable
                          key={r.recipeId}
                          style={styles.suggestRow}
                          onPress={() => quickLogRecipe(r.recipeId)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.suggestFoodName}>{r.recipeName}</Text>
                            <Text style={styles.suggestMeta}>Used {r.count}× · last {r.lastDate}</Text>
                          </View>
                          <Ionicons name="arrow-forward-circle-outline" size={24} color="#4f46e5" />
                        </Pressable>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* ── BY TYPE tab ── */}
              {suggestTab === 'bytype' && (
                <>
                  <View style={[styles.pickerButtons, { marginBottom: 14 }]}>
                    {['breakfast','lunch','dinner','snacks'].map(type => (
                      <Pressable
                        key={type}
                        onPress={() => setSuggestMealType(type)}
                        style={[styles.pickerButton, suggestMealType === type && styles.pickerButtonActive]}
                      >
                        <Text style={[styles.pickerButtonText, { fontSize: 12 }, suggestMealType === type && styles.pickerButtonTextActive]}>
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {(suggestions.byType[suggestMealType] || []).length === 0 ? (
                    <Text style={styles.emptyText}>No {suggestMealType} history yet.</Text>
                  ) : (
                    <>
                      <Text style={styles.suggestSectionLabel}>
                        What you usually have for {suggestMealType}
                      </Text>
                      {(suggestions.byType[suggestMealType] || []).map(item => (
                        <Pressable
                          key={item.foodId}
                          style={styles.suggestRow}
                          onPress={() => quickLogFood(item.foodId, suggestMealType, item.avgServingsByType?.[suggestMealType] || item.avgServings)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.suggestFoodName}>{item.foodName}</Text>
                            <Text style={styles.suggestMeta}>
                              {item.byType[suggestMealType]}× for {suggestMealType}
                            </Text>
                          </View>
                          <Ionicons name="arrow-forward-circle-outline" size={24} color="#10b981" />
                        </Pressable>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* ── SAME DAY tab ── */}
              {suggestTab === 'sameday' && (
                <>
                  {suggestions.sameDay.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No previous {suggestions.sameDayName} data yet. Keep logging and suggestions will appear!
                    </Text>
                  ) : (
                    <>
                      <Text style={styles.suggestSectionLabel}>
                        What you typically eat on {suggestions.sameDayName}s
                      </Text>
                      {suggestions.sameDay.map(item => (
                        <Pressable
                          key={item.foodId}
                          style={styles.suggestRow}
                          onPress={() => quickLogFood(item.foodId, item.mealType, item.avgServingsByType?.[item.mealType] || item.avgServings)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.suggestFoodName}>{item.foodName}</Text>
                            <Text style={styles.suggestMeta}>
                              {item.count}× on {suggestions.sameDayName}s · usually {item.mealType}
                            </Text>
                          </View>
                          <Ionicons name="arrow-forward-circle-outline" size={24} color="#7c3aed" />
                        </Pressable>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* ── FILL DAY tab ── */}
              {suggestTab === 'fillday' && fillDayPlan && (
                <>
                  {/* Remaining macro summary */}
                  <View style={styles.fillDayRemaining}>
                    <Text style={styles.suggestSectionLabel}>Remaining budget</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      {[
                        ['Cal', fillDayPlan.remaining.calories, ''],
                        ['Protein', fillDayPlan.remaining.protein, 'g'],
                        ['Carbs', fillDayPlan.remaining.carbs, 'g'],
                        ['Fats', fillDayPlan.remaining.fats, 'g'],
                      ].map(([label, val, unit]) => (
                        <View key={label} style={styles.fillDayBudgetChip}>
                          <Text style={styles.fillDayBudgetVal}>{val.toFixed(0)}{unit}</Text>
                          <Text style={styles.fillDayBudgetLabel}>{label}</Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* Fill Day search — matches food name, recipe name, AND recipe ingredients */}
                  <View style={[styles.searchBar, { marginBottom: 6 }]}>
                    <Ionicons name="search-outline" size={16} color="#9ca3af" />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Search foods & recipes…"
                      placeholderTextColor="#9ca3af"
                      value={fillSearch}
                      onChangeText={setFillSearch}
                      clearButtonMode="while-editing"
                    />
                    {(fillSearch.length > 0 || dismissedFillFoods.size > 0 || dismissedFillRecipes.size > 0) && (
                      <Pressable
                        onPress={() => { setFillSearch(''); setDismissedFillFoods(new Set()); setDismissedFillRecipes(new Set()); }}
                        hitSlop={8}
                      >
                        <Text style={{ fontSize: 11, color: '#dc2626', fontWeight: '600' }}>↺ Reset</Text>
                      </Pressable>
                    )}
                  </View>
                  {/* Quick-fill shortcut chips */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
                    {FILL_SHORTCUTS.map(s => (
                      <Pressable
                        key={s.text}
                        onPress={() => setFillSearch(fillSearch === s.text ? '' : s.text)}
                        style={{
                          paddingHorizontal: 11, paddingVertical: 5, borderRadius: 16,
                          backgroundColor: fillSearch === s.text ? '#4f46e5' : '#f3f4f6',
                          borderWidth: 1, borderColor: fillSearch === s.text ? '#4f46e5' : '#e5e7eb',
                        }}
                      >
                        <Text style={{ fontSize: 12, color: fillSearch === s.text ? '#fff' : '#374151', fontWeight: '500' }}>
                          {s.label}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>

                  {(() => {
                    const fq = fillSearch.trim().toLowerCase();

                    // ── SEARCH MODE: query the full library by name + ingredients ──
                    if (fq) {
                      const matchedFoods = foods.filter(f =>
                        (f.name || '').toLowerCase().includes(fq)
                      );
                      const matchedRecipes = recipes.filter(r =>
                        (r.name || '').toLowerCase().includes(fq) ||
                        (r.items || []).some(it => {
                          const ing = foods.find(f => f.id === Number(it.foodId));
                          return (ing?.name || '').toLowerCase().includes(fq);
                        })
                      );

                      if (!matchedFoods.length && !matchedRecipes.length) {
                        return <Text style={[styles.emptyText, { marginTop: 12 }]}>No foods or recipes match "{fq}".</Text>;
                      }

                      const SLOT_TYPES = ['breakfast', 'lunch', 'dinner', 'snacks'];
                      const defaultType = fillDayPlan?.activeTypes?.[0] || mealType || 'breakfast';

                      return (
                        <>
                          {matchedFoods.length > 0 && (
                            <>
                              <Text style={[styles.suggestSectionLabel, { marginTop: 8 }]}>Foods</Text>
                              {matchedFoods.map(food => (
                                <View key={food.id} style={[styles.suggestRow, { paddingRight: 6 }]}>
                                  <Pressable style={{ flex: 1 }} onPress={() => quickLogFood(food.id, defaultType, 1)}>
                                    <Text style={styles.suggestFoodName}>{food.name}</Text>
                                    <Text style={styles.suggestMeta}>{food.servingSize} · {food.calories ?? 0} cal/serving</Text>
                                    <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>tap → {defaultType} · or pick:</Text>
                                  </Pressable>
                                  <View style={{ flexDirection: 'row', gap: 5 }}>
                                    {SLOT_TYPES.map(t => (
                                      <Pressable key={t} onPress={() => quickLogFood(food.id, t, 1)}
                                        style={{ backgroundColor: '#e0f2fe', borderRadius: 8, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Text style={{ fontSize: 13, color: '#0369a1', fontWeight: '700' }}>{t[0].toUpperCase()}</Text>
                                      </Pressable>
                                    ))}
                                  </View>
                                </View>
                              ))}
                            </>
                          )}

                          {matchedRecipes.length > 0 && (
                            <>
                              <Text style={[styles.suggestSectionLabel, { marginTop: 10 }]}>Recipes</Text>
                              {matchedRecipes.map(recipe => {
                                const ingNames = (recipe.items || [])
                                  .map(it => foods.find(f => f.id === Number(it.foodId))?.name)
                                  .filter(Boolean).join(', ');
                                return (
                                  <View key={recipe.id} style={[styles.suggestRow, { backgroundColor: '#f5f3ff', borderRadius: 8, paddingVertical: 10, paddingLeft: 10, paddingRight: 6, borderBottomWidth: 0, marginTop: 4 }]}>
                                    <Pressable style={{ flex: 1 }} onPress={() => quickLogRecipe(recipe.id, defaultType)}>
                                      <Text style={[styles.suggestFoodName, { color: '#4f46e5' }]}>📖 {recipe.name}</Text>
                                      {ingNames ? <Text style={styles.suggestMeta} numberOfLines={1}>{ingNames}</Text> : null}
                                      <Text style={{ fontSize: 11, color: '#a78bfa', marginTop: 2 }}>tap → {defaultType} · or pick:</Text>
                                    </Pressable>
                                    <View style={{ flexDirection: 'row', gap: 5 }}>
                                      {SLOT_TYPES.map(t => (
                                        <Pressable key={t} onPress={() => quickLogRecipe(recipe.id, t)}
                                          style={{ backgroundColor: '#ede9fe', borderRadius: 8, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                          <Text style={{ fontSize: 13, color: '#7c3aed', fontWeight: '700' }}>{t[0].toUpperCase()}</Text>
                                        </Pressable>
                                      ))}
                                    </View>
                                  </View>
                                );
                              })}
                            </>
                          )}
                        </>
                      );
                    }

                    // ── NORMAL MODE: frequency-based slot suggestions ──
                    if (fillDayPlan.activeTypes.length === 0) {
                      return (
                        <Text style={[styles.emptyText, { marginTop: 16 }]}>
                          🎉 Daily macros met — great work!
                        </Text>
                      );
                    }

                    return fillDayPlan.activeTypes.map(type => {
                      const slot = fillDayPlan.slots[type];
                      const visibleCandidates = slot.candidates
                        .filter(f => !dismissedFillFoods.has(f.foodId))
                        .slice(0, 3);
                      const visibleRecipe = (slot.topRecipes || []).find(r =>
                        !dismissedFillRecipes.has(r.recipeId)
                      ) || null;

                      return (
                        <View key={type} style={{ marginTop: 16 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <Text style={styles.fillDayMealTitle}>
                              {type.charAt(0).toUpperCase() + type.slice(1)}
                            </Text>
                            <Text style={styles.fillDayMealBudget}>
                              ~{slot.targetCals.toFixed(0)} cal · {slot.targetProtein.toFixed(0)}g protein
                            </Text>
                          </View>

                          {slot.candidates.length === 0 ? (
                            <Text style={styles.emptyText}>No {type} history yet — log some meals first.</Text>
                          ) : visibleCandidates.length === 0 ? (
                            <Text style={styles.emptyText}>All dismissed — tap ↺ Reset to restore.</Text>
                          ) : (
                            visibleCandidates.map(item => (
                              <View key={item.foodId} style={[styles.suggestRow, { paddingRight: 6 }]}>
                                <Pressable style={{ flex: 1 }} onPress={() => quickLogFood(item.foodId, type, item.avgServings)}>
                                  <Text style={styles.suggestFoodName}>{item.foodName}</Text>
                                  <Text style={styles.suggestMeta}>
                                    ~{item.avgCals.toFixed(0)} cal · {item.avgProtein.toFixed(0)}g protein · logged {item.count}×
                                  </Text>
                                </Pressable>
                                <Pressable onPress={() => setDismissedFillFoods(prev => new Set([...prev, item.foodId]))} style={{ padding: 6, marginRight: 2 }} hitSlop={8}>
                                  <Ionicons name="close-circle-outline" size={20} color="#9ca3af" />
                                </Pressable>
                                <Pressable onPress={() => quickLogFood(item.foodId, type, item.avgServings)}>
                                  <Ionicons name="add-circle-outline" size={26} color="#10b981" />
                                </Pressable>
                              </View>
                            ))
                          )}

                          {visibleRecipe && (
                            <View style={[styles.suggestRow, { backgroundColor: '#f5f3ff', borderRadius: 8, padding: 10, borderBottomWidth: 0, marginTop: 4, paddingRight: 6 }]}>
                              <Pressable style={{ flex: 1 }} onPress={() => quickLogRecipe(visibleRecipe.recipeId, type)}>
                                <Text style={[styles.suggestFoodName, { color: '#4f46e5' }]}>📖 {visibleRecipe.recipeName}</Text>
                                <Text style={styles.suggestMeta}>Recipe · used {visibleRecipe.count}×</Text>
                              </Pressable>
                              <Pressable onPress={() => setDismissedFillRecipes(prev => new Set([...prev, visibleRecipe.recipeId]))} style={{ padding: 6, marginRight: 2 }} hitSlop={8}>
                                <Ionicons name="close-circle-outline" size={20} color="#9ca3af" />
                              </Pressable>
                              <Pressable onPress={() => quickLogRecipe(visibleRecipe.recipeId, type)}>
                                <Ionicons name="add-circle-outline" size={26} color="#4f46e5" />
                              </Pressable>
                            </View>
                          )}
                        </View>
                      );
                    });
                  })()}
                </>
              )}

              <View style={{ height: 16 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Calendar date picker modal */}
      <Modal visible={showCalendar} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: 20 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pick a date</Text>
              <Pressable onPress={() => setShowCalendar(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            {/* Month navigation */}
            <View style={styles.calMonthRow}>
              <Pressable onPress={() => shiftCalendarMonth(-1)} style={styles.dateButton}>
                <Ionicons name="chevron-back" size={22} color="#4f46e5" />
              </Pressable>
              <Text style={styles.calMonthTitle}>{MONTH_NAMES[calMonthNum]} {calYear}</Text>
              <Pressable onPress={() => shiftCalendarMonth(1)} style={styles.dateButton}>
                <Ionicons name="chevron-forward" size={22} color="#4f46e5" />
              </Pressable>
            </View>

            {/* Day-of-week headers */}
            <View style={styles.calWeekRow}>
              {['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => (
                <Text key={d} style={styles.calDowText}>{d}</Text>
              ))}
            </View>

            {/* Day grid */}
            <View style={styles.calGrid}>
              {getCalendarCells().map((day, idx) => {
                if (!day) return <View key={`empty-${idx}`} style={styles.calCell} />;
                const dateStr = `${calYear}-${String(calMonthNum + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const isSelected = dateStr === selectedDate;
                const isToday = dateStr === todayStr;
                const hasMeals = mealDates.has(dateStr);
                return (
                  <Pressable
                    key={dateStr}
                    style={[
                      styles.calCell,
                      isSelected && styles.calCellSelected,
                      !isSelected && isToday && styles.calCellToday,
                    ]}
                    onPress={() => {
                      setSelectedDate(dateStr);
                      setShowCalendar(false);
                    }}
                  >
                    <Text style={[styles.calDayText, isSelected && styles.calDayTextSelected]}>
                      {day}
                    </Text>
                    {hasMeals && <View style={[styles.calDot, isSelected && { backgroundColor: '#fff' }]} />}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>

      {/* Import progress overlay */}
      <Modal visible={importProgress !== null} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { alignItems: 'center', paddingVertical: 32 }]}>
            <Ionicons name="cloud-upload-outline" size={40} color="#4f46e5" style={{ marginBottom: 16 }} />
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#1f2937', marginBottom: 6 }}>
              Importing…
            </Text>
            <Text style={{ color: '#6b7280', marginBottom: 20 }}>
              {importProgress?.phase} · {importProgress?.done} / {importProgress?.total}
            </Text>
            {importProgress && (
              <View style={styles.progressTrack}>
                <View style={[
                  styles.progressFill,
                  { width: `${Math.round((importProgress.done / Math.max(importProgress.total, 1)) * 100)}%` }
                ]} />
              </View>
            )}
            <Text style={{ color: '#9ca3af', marginTop: 12, fontSize: 12 }}>
              {importProgress ? Math.round((importProgress.done / Math.max(importProgress.total, 1)) * 100) : 0}%
            </Text>
          </View>
        </View>
      </Modal>

      {/* Set Targets modal */}
      <Modal visible={showSetTargets} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Daily Targets</Text>
              <Pressable onPress={() => setShowSetTargets(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>
            <Text style={{ color: '#6b7280', fontSize: 12, marginBottom: 16 }}>
              Set your personal daily nutrition goals. Leave at 0 to skip tracking that macro.
            </Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {[
                ['Calories (kcal)', 'calories', '2000'],
                ['Protein (g)', 'protein', '150'],
                ['Carbs (g)', 'carbs', '250'],
                ['Fats (g)', 'fats', '65'],
                ['Fiber (g)', 'fiber', '30'],
                ['Sugar (g)', 'sugar', '50'],
                ['Added Sugar (g)', 'addedSugar', '25'],
                ['Sodium (mg)', 'sodium', '2300'],
              ].map(([label, key, ph]) => (
                <View key={key} style={{ marginBottom: 12 }}>
                  <Text style={styles.pickerLabel}>{label}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={ph}
                    placeholderTextColor="#9ca3af"
                    value={String(draftTargets[key] || '')}
                    onChangeText={v => setDraftTargets(prev => ({ ...prev, [key]: v }))}
                    keyboardType="decimal-pad"
                  />
                </View>
              ))}
              <Pressable
                onPress={saveTargets}
                style={[styles.modalPrimaryButton, { backgroundColor: '#7c3aed', marginTop: 8, marginBottom: 16 }]}
              >
                <Text style={styles.modalPrimaryButtonText}>Save Targets</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit logged meal modal */}
      <Modal visible={!!swapMeal} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit logged meal</Text>
              <Pressable onPress={() => { setSwapMeal(null); setSwapDate(''); }}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>

              {/* Food name */}
              <Text style={{ marginBottom: 14, color: '#374151', fontSize: 15, fontWeight: '600' }}>
                {swapMeal?.foodName ?? ''}
              </Text>

              {/* ── Amount + mode ── */}
              <Text style={styles.inputLabel}>Amount</Text>
              {/* Mode tabs */}
              <View style={[styles.pickerButtons, { marginBottom: 8 }]}>
                {[
                  { val: 'servings', label: 'Servings' },
                  { val: 'amount',   label: (() => {
                    const food = foods.find(f => f.id === swapMeal?.foodId);
                    const p = food ? extractServingAmount(food.servingSize) : null;
                    return p ? expandUnit(p.label) : 'Grams/Units';
                  })() },
                ].map(({ val, label }) => (
                  <Pressable key={val}
                    onPress={() => {
                      if (val === swapMode) return;
                      // Auto-convert the current amount to the new unit
                      const food = foods.find(f => f.id === swapMeal?.foodId);
                      const parsed = food ? extractServingAmount(food.servingSize) : null;
                      const cur = parseFloat(swapServings);
                      if (food && parsed && Number.isFinite(cur) && cur > 0) {
                        if (val === 'amount') {
                          // servings → grams/units
                          setSwapServings(String(Math.round(cur * parsed.perServing * 10) / 10));
                        } else {
                          // grams/units → servings
                          setSwapServings(String(Math.round((cur / parsed.perServing) * 100) / 100));
                        }
                      }
                      setSwapMode(val);
                    }}
                    style={[styles.pickerButton, { flex: 1, justifyContent: 'center' }, swapMode === val && styles.pickerButtonActive]}
                  >
                    <Text style={[styles.pickerButtonText, swapMode === val && styles.pickerButtonTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={styles.input}
                value={swapServings}
                onChangeText={setSwapServings}
                keyboardType="decimal-pad"
                placeholder={swapMode === 'amount'
                  ? (() => { const food = foods.find(f => f.id === swapMeal?.foodId); const p = food ? extractServingAmount(food.servingSize) : null; return p ? `Amount in ${expandUnit(p.label).toLowerCase()}` : 'Amount'; })()
                  : 'Number of servings'}
                placeholderTextColor="#9ca3af"
              />

              {/* ── Date — 7-day week strip ── */}
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>Date</Text>
              {(() => {
                const center = swapDate || selectedDate;
                const d = new Date(center + 'T00:00:00');
                const weekDays = Array.from({ length: 7 }, (_, i) => {
                  const day = new Date(d);
                  day.setDate(d.getDate() - 3 + i);
                  return day.toISOString().split('T')[0];
                });
                const DAY_LABELS = ['S','M','T','W','T','F','S'];
                return (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Pressable onPress={() => shiftSwapDate(-7)} style={{ padding: 6 }}>
                      <Ionicons name="chevron-back" size={20} color="#4f46e5" />
                    </Pressable>
                    <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between' }}>
                      {weekDays.map(dateStr => {
                        const dayObj = new Date(dateStr + 'T00:00:00');
                        const dayNum = dayObj.getDate();
                        const dayLabel = DAY_LABELS[dayObj.getDay()];
                        const isSelected = dateStr === swapDate;
                        const isToday = dateStr === selectedDate;
                        return (
                          <Pressable key={dateStr} onPress={() => setSwapDate(dateStr)}
                            style={{
                              alignItems: 'center', paddingVertical: 6, paddingHorizontal: 5,
                              borderRadius: 8, minWidth: 34,
                              backgroundColor: isSelected ? '#4f46e5' : isToday ? '#ede9fe' : 'transparent',
                            }}>
                            <Text style={{ fontSize: 11, color: isSelected ? '#fff' : '#9ca3af', fontWeight: '600' }}>{dayLabel}</Text>
                            <Text style={{ fontSize: 15, fontWeight: '700', color: isSelected ? '#fff' : isToday ? '#4f46e5' : '#1f2937' }}>{dayNum}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Pressable onPress={() => shiftSwapDate(7)} style={{ padding: 6 }}>
                      <Ionicons name="chevron-forward" size={20} color="#4f46e5" />
                    </Pressable>
                  </View>
                );
              })()}

              {/* ── Meal type ── */}
              <Text style={[styles.inputLabel, { marginTop: 16 }]}>Meal type</Text>
              <View style={[styles.pickerButtons, { marginBottom: 16 }]}>
                {['breakfast', 'lunch', 'dinner', 'snacks'].map(type => (
                  <Pressable key={type} onPress={() => setSwapMealType(type)}
                    style={[styles.pickerButton, swapMealType === type && styles.pickerButtonActive]}>
                    <Text style={[styles.pickerButtonText, swapMealType === type && styles.pickerButtonTextActive]}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                onPress={saveSwapChanges}
                style={[styles.addButton, { justifyContent: 'center', paddingVertical: 14, backgroundColor: '#4f46e5', marginBottom: 4 }]}
              >
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={styles.addButtonText}>Save Changes</Text>
              </Pressable>

            </ScrollView>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f9ff' },
  pageContent: { paddingBottom: 24 },

  title: {
    fontSize: 32, fontWeight: 'bold', color: '#1f2937',
    textAlign: 'center', marginVertical: 20,
  },

  familyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8,
    backgroundColor: '#ede9fe', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  familyBannerText: { fontSize: 13, color: '#4f46e5', flex: 1 },

  memberBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: 6,
  },
  memberBarLabel: { fontSize: 13, color: '#6b7280', fontWeight: '600' },
  memberChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    borderWidth: 1.5, borderColor: '#d1d5db', backgroundColor: '#fff', marginRight: 8,
  },
  memberChipActive: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  memberChipText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  memberChipTextActive: { color: '#fff' },

  viewingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: 16, marginBottom: 6,
    backgroundColor: '#fef3c7', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  viewingBannerText: { fontSize: 12, color: '#92400e' },

  section: {
    backgroundColor: '#fff', margin: 16, padding: 16, borderRadius: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1, shadowRadius: 4, elevation: 3,
  },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: '#374151' },

  addButton: {
    backgroundColor: '#4f46e5', flexDirection: 'row',
    alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 8, gap: 8,
  },
  addButtonText: { color: '#fff', fontWeight: '600' },
  emptyText: { color: '#6b7280', fontSize: 13 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f9fafb',
    borderWidth: 1, borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#111827', paddingVertical: 0 },

  foodItem: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    padding: 12, marginHorizontal: 16, marginBottom: 12, backgroundColor: '#fff',
  },
  foodHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  foodInfo: { flex: 1 },
  foodName: { fontSize: 16, fontWeight: '600', color: '#1f2937' },
  foodServing: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  foodActions: { flexDirection: 'row', gap: 8 },
  iconButton: { padding: 4 },

  macroGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  macroText: { fontSize: 12, color: '#4b5563', width: '30%' },
  editingContainer: { gap: 8 },

  input: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 12, fontSize: 14, backgroundColor: '#f3f4f6', color: '#111827',
  },
  macroEditGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  macroInput: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    padding: 8, fontSize: 12, width: '30%', backgroundColor: '#f3f4f6', color: '#111827',
  },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },

  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  summaryCard: { width: '47%', padding: 16, borderRadius: 8 },
  summaryLabel: { fontSize: 12, fontWeight: '500', color: '#78350f' },
  summaryValue: { fontSize: 28, fontWeight: 'bold', color: '#78350f', marginTop: 4 },

  dateSelector: { flex: 1 },
  dateControls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  dateButton: { padding: 4 },
  dateText: { fontSize: 14, color: '#4b5563', fontWeight: '500' },

  mealTypeSection: { marginTop: 16 },
  mealTypeTitle: {
    fontSize: 16, fontWeight: '600', color: '#374151',
  },
  mealItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#f9fafb', padding: 12, borderRadius: 8, marginBottom: 8,
  },
  mealInfo: { flex: 1 },
  mealName: { fontSize: 14, fontWeight: '500', color: '#1f2937' },
  mealDetails: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  mealItemDisabled: { opacity: 0.45 },
  mealActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff', borderRadius: 12, padding: 24,
    width: '90%', maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: '600' },
  modalScroll: { maxHeight: 500 },
  modalForm: { gap: 12 },
  modalButton: { width: '100%', marginTop: 8, justifyContent: 'center' },

  pickerContainer: { marginBottom: 12 },
  pickerLabel: { fontSize: 14, fontWeight: '500', color: '#374151', marginBottom: 8 },
  pickerButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickerButton: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff',
  },
  pickerButtonActive: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  pickerButtonFillDay: { backgroundColor: '#10b981', borderColor: '#10b981' },
  pickerButtonText: { fontSize: 14, color: '#6b7280' },
  pickerButtonTextActive: { color: '#fff', fontWeight: '600' },

  foodSelector: { maxHeight: 150, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8 },
  foodOption: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  foodOptionActive: { backgroundColor: '#dbeafe' },
  foodOptionText: { fontSize: 14, color: '#374151' },
  foodOptionTextActive: { fontWeight: '600', color: '#1e40af' },

  modalBottomBar: { paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  modalPrimaryButton: {
    width: '100%', paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  modalPrimaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  topActions: { flexDirection: 'row', gap: 12, marginHorizontal: 16, marginBottom: 8 },
  exportButton: {
    flex: 1, backgroundColor: '#111827', flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
  },
  exportButtonText: { color: '#fff', fontWeight: '700' },

  dateChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 10,
    borderRadius: 10, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff',
  },
  dateChipText: { color: '#4f46e5', fontWeight: '700' },

  recipeCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#f9fafb', padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  recipeName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  recipeMeta: { marginTop: 2, fontSize: 12, color: '#6b7280' },

  weeklyButton: {
    backgroundColor: '#111827', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
  },
  weeklyButtonText: { color: '#fff', fontWeight: '700' },

  weekCard: {
    width: '47%', padding: 14, borderRadius: 10,
    borderWidth: 1, borderColor: '#e5e7eb', backgroundColor: '#f9fafb',
  },
  weekLabel: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  weekValue: { marginTop: 6, fontSize: 20, color: '#111827', fontWeight: '800' },
  emptySearchText: { padding: 12, color: '#6b7280', fontSize: 13 },

  // Sync badge
  syncBadgeText: { fontSize: 11, color: '#4f46e5', marginTop: 3, opacity: 0.85 },

  // Date picker enhancements
  dateTouchable: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, backgroundColor: '#ede9fe',
  },
  todayButton: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
    backgroundColor: '#10b981',
  },
  todayButtonText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  // Calendar modal
  calMonthRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  calMonthTitle: { fontSize: 17, fontWeight: '700', color: '#1f2937' },
  calWeekRow: {
    flexDirection: 'row', marginBottom: 6,
  },
  calDowText: {
    flex: 1, textAlign: 'center', fontSize: 12,
    fontWeight: '600', color: '#9ca3af',
  },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: {
    width: '14.28%', aspectRatio: 1, alignItems: 'center',
    justifyContent: 'center', borderRadius: 8,
  },
  calCellSelected: { backgroundColor: '#4f46e5' },
  calCellToday: { borderWidth: 2, borderColor: '#4f46e5' },
  calDayText: { fontSize: 14, color: '#1f2937', fontWeight: '500' },
  calDayTextSelected: { color: '#fff', fontWeight: '700' },
  calDot: {
    width: 4, height: 4, borderRadius: 2,
    backgroundColor: '#4f46e5', marginTop: 2,
  },

  // Macro target progress bars
  targetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  targetLabel: { width: 52, fontSize: 12, color: '#374151', fontWeight: '600' },
  targetBarWrap: {
    flex: 1, height: 9, backgroundColor: '#e5e7eb', borderRadius: 5, overflow: 'hidden',
  },
  targetBarFill: { height: '100%', borderRadius: 5 },
  targetValues: { width: 88, alignItems: 'flex-end' },
  targetConsumed: { fontSize: 11, color: '#374151', fontWeight: '600' },
  targetLeft: { fontSize: 10, color: '#10b981' },

  // Fill My Day
  fillDayRemaining: {
    backgroundColor: '#f0fdf4', borderRadius: 10, padding: 12, marginBottom: 4,
  },
  fillDayBudgetChip: {
    backgroundColor: '#fff', borderRadius: 8, padding: 8,
    alignItems: 'center', minWidth: 60,
    borderWidth: 1, borderColor: '#d1fae5',
  },
  fillDayBudgetVal: { fontSize: 16, fontWeight: '800', color: '#065f46' },
  fillDayBudgetLabel: { fontSize: 10, color: '#6b7280', marginTop: 2 },
  fillDayMealTitle: { fontSize: 15, fontWeight: '700', color: '#111827' },
  fillDayMealBudget: { fontSize: 11, color: '#9ca3af' },

  // Meal suggester
  suggestSectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#6b7280',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8,
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 10,
  },
  suggestFoodName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  suggestMeta: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  suggestTypeChip: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#ede9fe', alignItems: 'center', justifyContent: 'center',
  },
  suggestTypeChipText: { fontSize: 11, fontWeight: '800', color: '#4f46e5' },

  // Progress bar
  progressTrack: {
    width: '100%', height: 10, backgroundColor: '#e5e7eb',
    borderRadius: 5, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', backgroundColor: '#4f46e5', borderRadius: 5,
  },
});
