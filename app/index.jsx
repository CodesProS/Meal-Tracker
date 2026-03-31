import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList, Keyboard, KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';


const STORAGE_KEYS = {
  foods: 'foods',
  meals: 'meals',
  recipes: 'recipes',
};

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    const parsed = JSON.parse(value);
    return parsed;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [foods, setFoods] = useState([]);
  const [meals, setMeals] = useState([]);
  const [hydrated, setHydrated] = useState(false);

  const [showAddFood, setShowAddFood] = useState(false);
  const [showAddMeal, setShowAddMeal] = useState(false);
  const [editingFood, setEditingFood] = useState(null);
  const [swapMeal, setSwapMeal] = useState(null);
  const [swapDate, setSwapDate] = useState('');
  const [swapServings, setSwapServings] = useState('');
  const [recipes, setRecipes] = useState([]);
  const [showRecipeBuilder, setShowRecipeBuilder] = useState(false);

  const [editingRecipeId, setEditingRecipeId] = useState(null);
  const [newRecipeName, setNewRecipeName] = useState('');
  const [newRecipeItems, setNewRecipeItems] = useState([]);
  const [recipeYield, setRecipeYield] = useState('2'); // string for TextInput
  const [recipeSearch, setRecipeSearch] = useState('');

  // array of { foodId: number, servings: string }

  const [recipeFoodPickerId, setRecipeFoodPickerId] = useState('');
  const [recipeFoodServings, setRecipeFoodServings] = useState('1');
  const [foodSearch, setFoodSearch] = useState('');

  const [logMode, setLogMode] = useState('food'); // 'food' | 'recipe'
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [recipeDraftItems, setRecipeDraftItems] = useState([]);
  // array of { foodId: number, servings: string }

  const [recipeInputMode, setRecipeInputMode] = useState('servings'); // 'servings' | 'amount'
  const [recipeFoodUnits, setRecipeFoodUnits] = useState('100');

  const [mealInputMode, setMealInputMode] = useState('servings'); // 'servings' | 'amount'
  const [mealAmount, setMealAmount] = useState('1'); // user input (servings or units)

  const [recipePortionsEaten, setRecipePortionsEaten] = useState('1');
  const [recipeLogMode, setRecipeLogMode] = useState('portions'); // 'portions' | 'weight'
  const [recipeLoggedWeight, setRecipeLoggedWeight] = useState('');
  const [recipeFinalWeight, setRecipeFinalWeight] = useState('');
  const [recipeIngredientSearch, setRecipeIngredientSearch] = useState('');

  const [showWeeklyStats, setShowWeeklyStats] = useState(false);

  const MEASURABLE_UNITS = [
    'g', 'gram', 'grams',
    'kg', 'mg',
    'ml', 'l', 'liter', 'liters',
    'cup', 'cups',
    'tbsp', 'tsp',
    'oz', 'fl oz', 'lb'
  ];

  const normalizeUnit = (unit) => {
    const u = String(unit || '').trim().toLowerCase();

    const map = {
      gram: 'g',
      grams: 'g',
      kg: 'kg',
      mg: 'mg',
      liter: 'l',
      liters: 'l',
      cup: 'cup',
      cups: 'cup',
      tbsp: 'tbsp',
      tsp: 'tsp',
      oz: 'oz',
      'fl oz': 'fl oz',
      lb: 'lb',
      ml: 'ml',
      l: 'l',
    };
    return map[u] || u;
  };

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

  const buildMealRowFromFood = (food, servingsEq, date, mealType, recipeMeta, mode, amount) => {
    return {
      id: Date.now() + Math.floor(Math.random() * 100000),
      date,
      mealType,
      enabled: true,
      foodId: food.id,
      foodName: food.name,
      amountLabel:
        mode === 'amount'
          ? extractServingAmount(food.servingSize)?.label || ''
          : '',

      // ✅ store how it was logged
      mode: mode || 'servings',
      amount: Number.isFinite(Number(amount)) ? Number(amount) : servingsEq,

      // ✅ servings-equivalent for calculations
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
    };
  };

  const extractServingUnit = (servingSize) => {
    if (!servingSize) return null;

    const text = String(servingSize).trim().toLowerCase();

    // supports: "240 ml", "1 cup", "30 g", "2 tbsp"
    const match = text.match(/^([\d.]+)\s*([a-zA-Z].*)$/);
    if (!match) return null;

    const amount = parseFloat(match[1]);
    const rawUnit = match[2].trim();
    const unit = normalizeUnit(rawUnit);

    if (!Number.isFinite(amount) || amount <= 0) return null;

    if (!MEASURABLE_UNITS.includes(unit)) return null;

    return {
      amountPerServing: amount,
      unit,
    };
  };

  const handleLogRecipe = () => {
    if (!selectedRecipeId) return;

    const recipe = recipes.find(r => r.id === Number(selectedRecipeId));
    if (!recipe) return;

    let portionFactor = NaN;

    if (recipeLogMode === 'weight') {
      const loggedWeightNum = parseFloat(recipeLoggedWeight);
      const finalWeightNum = Number(recipe.finalWeight);

      if (!Number.isFinite(loggedWeightNum) || loggedWeightNum <= 0) return;
      if (!Number.isFinite(finalWeightNum) || finalWeightNum <= 0) {
        Alert.alert(
          'Recipe weight not available',
          'This recipe does not have a final weight saved.'
        );
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
      recipePortionsEaten:
        recipeLogMode === 'portions' ? parseFloat(recipePortionsEaten) : null,
      loggedRecipeWeight:
        recipeLogMode === 'weight' ? parseFloat(recipeLoggedWeight) : null,
      recipeFinalWeight:
        recipeLogMode === 'weight' ? Number(recipe.finalWeight) : null,
      recipeLogMode,
      portionFactor,
    };

    const rows = recipeDraftItems
      .map((it) => {
        const food = foods.find(f => f.id === Number(it.foodId));
        if (!food) return null;

        const servingsEq = toServings(food, it);
        if (!Number.isFinite(servingsEq) || servingsEq <= 0) return null;

        const scaledServingsEq = servingsEq * portionFactor;

        const rawAmt = parseFloat(String(it.amount));
        const scaledAmount = Number.isFinite(rawAmt)
          ? rawAmt * portionFactor
          : scaledServingsEq;

        return buildMealRowFromFood(
          food,
          scaledServingsEq,
          selectedDate,
          mealType,
          recipeMeta,
          it.mode,
          scaledAmount
        );
      })
      .filter(Boolean);

    if (rows.length === 0) return;

    setMeals(prev => [...prev, ...rows]);
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
  };



  const [newFood, setNewFood] = useState({
    name: '',
    servingSize: '',
    calories: '',
    protein: '',
    carbs: '',
    fats: '',
    sugar: '',
    addedSugar: '',
    sodium: '',
    fiber: '',
  });

  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [mealType, setMealType] = useState('breakfast');
  const [selectedFoodId, setSelectedFoodId] = useState('');

  const importAllData = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const fileUri = result.assets[0].uri;
      const content = await FileSystem.readAsStringAsync(fileUri);

      const parsed = JSON.parse(content);

      if (!parsed || !parsed.foods || !parsed.meals) {
        Alert.alert('Invalid file', 'This does not look like a valid backup.');
        return;
      }

      Alert.alert(
        'Import data?',
        'This will replace current data in the app.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Import',
            style: 'destructive',
            onPress: async () => {
              const importedFoods = parsed.foods || [];

              const importedMeals = (parsed.meals || []).map((m) => {
                const servingsEq = Number(m?.servings);
                const safeServings =
                  Number.isFinite(servingsEq) && servingsEq > 0 ? servingsEq : 1;

                return {
                  ...m,
                  mode:
                    m?.mode === 'grams' || m?.mode === 'units' || m?.mode === 'quantity'
                      ? 'amount'
                      : (m?.mode || 'servings'),
                  amount: m?.amount != null ? m.amount : safeServings,
                  servings: safeServings,
                };
              });

              const importedRecipes = (parsed.recipes || []).map((r) => ({
                ...r,
                items: (r.items || []).map((it) => ({
                  ...it,
                  mode:
                    it.mode === 'grams' || it.mode === 'units' || it.mode === 'quantity'
                      ? 'amount'
                      : (it.mode || 'servings'),
                })),
              }));

              setFoods(importedFoods);
              setMeals(importedMeals);
              setRecipes(importedRecipes);

              await AsyncStorage.setItem(STORAGE_KEYS.foods, JSON.stringify(importedFoods));
              await AsyncStorage.setItem(STORAGE_KEYS.meals, JSON.stringify(importedMeals));
              await AsyncStorage.setItem(STORAGE_KEYS.recipes, JSON.stringify(importedRecipes));

              Alert.alert('Success', 'Data imported successfully.');
            },
          },
        ]
      );
    } catch (e) {
      console.log('Import failed:', e);
      Alert.alert('Import failed', 'Could not import the backup file.');
    }
  };

  const getWeekStartMonday = (yyyyMmDd) => {
    const d = new Date(yyyyMmDd + 'T00:00:00'); // local midnight
    const day = d.getDay(); // 0..6 (Sun..Sat)

    // If Sunday (0), go back 6 days. Else go back (day - 1).
    const diffToMonday = day === 0 ? 6 : day - 1;

    d.setDate(d.getDate() - diffToMonday);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  };

  const addDays = (yyyyMmDd, days) => {
    const d = new Date(yyyyMmDd + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const weekStart = getWeekStartMonday(selectedDate);
  const weekEnd = addDays(weekStart, 6);


  const inRange = (dateStr, startStr, endStr) =>
    dateStr >= startStr && dateStr <= endStr;

  const weekMeals = meals.filter(
    (m) => (m.enabled ?? true) && inRange(m.date, weekStart, weekEnd)
  );


  const exportAllData = async () => {
    try {
      const payload = {
        app: 'meal-tracker',
        version: 1,
        exportedAt: new Date().toISOString(),
        foods,
        meals,
        recipes
      };

      const json = JSON.stringify(payload, null, 2);
      const fileName = `meal-tracker-export-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      const uri = FileSystem.documentDirectory + fileName;

      await FileSystem.writeAsStringAsync(uri, json);


      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/json',
          dialogTitle: 'Export Meal Tracker Data',
          UTI: 'public.json', // iOS hint
        });
      } else {
        // fallback (rare): share text
        await Share.share({ message: json });
      }
    } catch (e) {
      console.log('Export failed:', e);
      Alert.alert('Export failed', 'Could not export your data. Check console logs.');
    }
  };


  // Load once on mount
  useEffect(() => {
    (async () => {
      try {


        const foodsData = await AsyncStorage.getItem(STORAGE_KEYS.foods);
        const mealsData = await AsyncStorage.getItem(STORAGE_KEYS.meals);
        const recipesData = await AsyncStorage.getItem(STORAGE_KEYS.recipes);

        console.log('EXPO GO RAW foods:', foodsData);
        console.log('EXPO GO RAW meals:', mealsData);
        console.log('EXPO GO RAW recipes:', recipesData);

        const loadedFoods = safeJsonParse(foodsData, []);
        const loadedMeals = safeJsonParse(mealsData, []);
        const loadedRecipes = safeJsonParse(recipesData, []);

        const foodsArr = Array.isArray(loadedFoods) ? loadedFoods : [];
        const mealsArr = Array.isArray(loadedMeals) ? loadedMeals : [];
        const recipesArr = Array.isArray(loadedRecipes) ? loadedRecipes : [];

        // MIGRATE meals: ensure mode + amount exist for older entries
        const migratedMeals = mealsArr.map((m) => {
          const servingsEq = Number(m?.servings);
          const safeServings = Number.isFinite(servingsEq) && servingsEq > 0 ? servingsEq : 1;

          let normalizedMode = m?.mode || 'servings';
          if (normalizedMode === 'grams' || normalizedMode === 'units' || normalizedMode === 'quantity') {
            normalizedMode = 'amount';
          }

          const food = foodsArr.find(f => f.id === m.foodId);
          const parsed = food ? extractServingAmount(food.servingSize) : null;

          return {
            ...m,
            mode: normalizedMode,
            amount: m?.amount != null ? m.amount : safeServings,
            servings: safeServings,
            amountLabel: normalizedMode === 'amount' ? (m.amountLabel || parsed?.label || '') : '',
            calories: Number(m?.calories) || 0,
            protein: Number(m?.protein) || 0,
            carbs: Number(m?.carbs) || 0,
            fats: Number(m?.fats) || 0,
            sugar: Number(m?.sugar) || 0,
            addedSugar: Number(m?.addedSugar) || 0,
            sodium: Number(m?.sodium) || 0,
            fiber: Number(m?.fiber) || 0,
          };
        });

        const migratedRecipes = recipesArr.map((r) => ({
          ...r,
          finalWeight: Number.isFinite(Number(r.finalWeight))
            ? Number(r.finalWeight)
            : '',
          items: (r.items || []).map((it) => {
            let normalizedMode = it.mode || 'servings';
            if (normalizedMode === 'grams' || normalizedMode === 'units' || normalizedMode === 'quantity') {
              normalizedMode = 'amount';
            }

            return {
              ...it,
              mode: normalizedMode,
            };
          }),
        }));

        setFoods(foodsArr);
        setMeals(migratedMeals);
        setRecipes(migratedRecipes);
      } catch (error) {
        console.log('Error loading data:', error);
        setFoods([]);
        setMeals([]);
        setRecipes([]);
      } finally {
        setHydrated(true);
      }
    })();
  }, []);


  // Auto-save after hydration (IMPORTANT: saves even empty arrays)
  useEffect(() => {
    if (!hydrated) return;
    (async () => {
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.foods, JSON.stringify(foods));
        await AsyncStorage.setItem(STORAGE_KEYS.meals, JSON.stringify(meals));
        await AsyncStorage.setItem(STORAGE_KEYS.recipes, JSON.stringify(recipes));
      } catch (error) {
        console.log('Error saving data:', error);
      }
    })();
  }, [foods, meals, recipes, hydrated]);

  const resetNewFood = () => {
    setNewFood({
      name: '',
      servingSize: '',
      calories: '',
      protein: '',
      carbs: '',
      fats: '',
      sugar: '',
      addedSugar: '',
      sodium: '',
      fiber: '',
    });
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

  const handleAddFood = () => {
    if (!newFood.name || newFood.calories === '') return;

    const food = normalizeFood({
      id: Date.now(),
      ...newFood,
    });

    setFoods((prev) => [...prev, food]);
    resetNewFood();
    setShowAddFood(false);
  };

  const handleUpdateFood = () => {
    if (!editingFood || !editingFood.name || editingFood.calories === '') return;

    const updatedFood = normalizeFood(editingFood);

    setFoods((prev) => prev.map((f) => (f.id === updatedFood.id ? updatedFood : f)));

    setMeals((prevMeals) =>
      prevMeals.map((m) => {
        if (m.foodId !== updatedFood.id) return m;

        const servingsEq = Number(m.servings);
        const safeServingsEq = Number.isFinite(servingsEq) ? servingsEq : 0;

        return {
          ...m,
          foodName: updatedFood.name,
          calories: (updatedFood.calories || 0) * safeServingsEq,
          protein: (updatedFood.protein || 0) * safeServingsEq,
          carbs: (updatedFood.carbs || 0) * safeServingsEq,
          fats: (updatedFood.fats || 0) * safeServingsEq,
          sugar: (updatedFood.sugar || 0) * safeServingsEq,
          addedSugar: (updatedFood.addedSugar || 0) * safeServingsEq,
          sodium: (updatedFood.sodium || 0) * safeServingsEq,
          fiber: (updatedFood.fiber || 0) * safeServingsEq,
        };
      })
    );


    setEditingFood(null);
  };

  const handleDeleteFood = (id) => {
    setFoods((prevFoods) => prevFoods.filter((f) => f.id !== id));
    // Remove meals that reference this food (prevents orphan meals)
    setMeals((prevMeals) => prevMeals.filter((m) => m.foodId !== id));
  };

  const handleAddMeal = () => {

    if (!selectedFoodId) return;

    const food = foods.find((f) => f.id === Number(selectedFoodId));
    if (!food) return;

    if (mealInputMode === 'amount') {
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed) {
        Alert.alert(
          'Amount not supported for this item',
          'This food’s serving size must look like "240 ml", "30 g", "1 cup", "10 almonds", or "2 cookies". Edit the food or log by servings.'
        );
        return;
      }
    }

    const servingsEq = toServingsFromInput(food, mealInputMode, mealAmount);
    if (!Number.isFinite(servingsEq) || servingsEq <= 0) return;

    const amountNum = parseFloat(String(mealAmount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) return;

    const parsedAmount = mealInputMode === 'amount'
      ? extractServingAmount(food.servingSize)
      : null;

    const meal = {
      id: Date.now(),
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

    setMeals((prev) => [...prev, meal]);
    setShowAddMeal(false);
    setSelectedFoodId('');
    setMealInputMode('servings');
    setMealAmount('1');
    setFoodSearch('');
  };

  const handleDeleteMeal = (id) => {
    setMeals((prev) => prev.filter((m) => m.id !== id));
  };

  const updateMealType = (mealId, newType) => {
    setMeals((prev) =>
      prev.map((m) => (m.id === mealId ? { ...m, mealType: newType } : m))
    );
  };

  const toggleMealEnabled = (mealId) => {
    setMeals((prev) =>
      prev.map((m) =>
        m.id === mealId ? { ...m, enabled: !(m.enabled ?? true) } : m
      )
    );
  };

  const isValidYYYYMMDD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const shiftSwapDate = (days) => {
    const base = (swapDate || selectedDate) + 'T00:00:00';
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    setSwapDate(d.toISOString().split('T')[0]);
  };

  const saveSwapChanges = (newMealType) => {
    if (!swapMeal) return;

    const finalDate = swapDate || swapMeal.date;

    const food = foods.find((f) => f.id === swapMeal.foodId);
    if (!food) {
      Alert.alert('Food not found', 'Original food item is missing');
      return;
    }

    const mode = swapMeal.mode || 'servings';
    const amountNum = parseFloat(String(swapServings));

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      Alert.alert(
        'Invalid amount',
        mode === 'amount'
          ? 'Amounts must be positive'
          : 'Servings must be positive'
      );
      return;
    }

    if (mode === 'amount') {
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed) {
        Alert.alert(
          'Amount not supported',
          'This food does not have a valid serving format.'
        );
        return;
      }
    }

    const servingsEq = toServingsFromInput(food, mode, amountNum);
    if (!Number.isFinite(servingsEq) || servingsEq <= 0) {
      Alert.alert('Invalid amount', 'Could not convert input to servings.');
      return;
    }

    if (!isValidYYYYMMDD(finalDate)) {
      Alert.alert('Invalid date', 'Use format YYYY-MM-DD');
      return;
    }

    setMeals((prev) =>
      prev.map((m) =>
        m.id === swapMeal.id
          ? {
            ...m,
            mealType: newMealType,
            date: finalDate,
            amountLabel:
              mode === 'amount'
                ? extractServingAmount(food.servingSize)?.label || ''
                : '',
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
          }
          : m
      )
    );

    setSwapMeal(null);
    setSwapDate('');
    setSwapServings('');
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
    setRecipeFoodQuantity('1');
    setRecipeFoodUnits('100');
    setRecipeFinalWeight(String(r.finalWeight ?? ''));
  };

  const confirmDeleteRecipe = (recipeId) => {
    Alert.alert(
      'Delete recipe?',
      'This will remove the recipe from your library.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setRecipes(prev => prev.filter(r => r.id !== Number(recipeId)));
            // optional: if user had recipe selected in Log Meal modal
            if (String(recipeId) === selectedRecipeId) {
              setSelectedRecipeId('');
              setRecipeDraftItems([]);
            }
          }
        }
      ]
    );
  };

  const resetRecipeBuilder = () => {
    setEditingRecipeId(null);
    setNewRecipeName('');
    setNewRecipeItems([]);
    setRecipeFoodPickerId('');
    setRecipeFoodServings('1');
    setRecipeFoodQuantity('1');
    setRecipeInputMode('servings');
    setRecipeFoodUnits('100');
    setRecipeYield('2'); // or '1' if you prefer
    setRecipeFinalWeight('');
    setRecipeLogMode('portions');
    setRecipeLoggedWeight('');
    setRecipeIngredientSearch('');
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

    // reject measurable units, because those belong in "units" mode
    if (MEASURABLE_UNITS.includes(unit)) return null;

    return {
      quantityPerServing: qty,
      quantityUnit: rawUnit || 'item(s)',
    };
  };

  const extractServingAmount = (servingSize) => {
    const measurable = extractServingUnit(servingSize);
    if (measurable) {
      return {
        kind: 'measurable',
        perServing: measurable.amountPerServing,
        label: measurable.unit,
      };
    }

    const quantity = extractServingQuantity(servingSize);
    if (quantity) {
      return {
        kind: 'count',
        perServing: quantity.quantityPerServing,
        label: quantity.quantityUnit,
      };
    }

    return null;
  };



  const toServingsFromInput = (food, mode, amountRaw) => {
    const amount = parseFloat(String(amountRaw));
    if (!food || !Number.isFinite(amount) || amount <= 0) return NaN;

    if (mode === 'servings') return amount;

    if (mode === 'amount') {
      const parsed = extractServingAmount(food.servingSize);
      if (!parsed || !Number.isFinite(parsed.perServing) || parsed.perServing <= 0) {
        return NaN;
      }
      return amount / parsed.perServing;
    }

    return NaN;
  };

  const addIngredientToBuilder = () => {
    const foodIdNum = Number(recipeFoodPickerId);
    if (!foodIdNum) {
      Alert.alert('Pick a food', 'Select a food ingredient first.');
      return;
    }

    const food = foods.find(f => f.id === foodIdNum);
    if (!food) return;

    if (recipeInputMode === 'servings') {
      const servingsNum = parseFloat(recipeFoodServings);
      if (!Number.isFinite(servingsNum) || servingsNum <= 0) {
        Alert.alert('Invalid servings', 'Servings must be a positive number.');
        return;
      }

      setNewRecipeItems(prev => [
        ...prev,
        { foodId: foodIdNum, mode: 'servings', amount: servingsNum },
      ]);
    } else {
      const amountNum = parseFloat(recipeFoodUnits);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        Alert.alert('Invalid amount', 'Amount must be a positive number.');
        return;
      }

      const parsed = extractServingAmount(food.servingSize);
      if (!parsed) {
        Alert.alert(
          'Amount not supported for this item',
          'This food’s serving size must look like "240 ml", "30 g", "1 cup", "10 almonds", or "2 cookies". Edit the food or add by servings.'
        );
        return;
      }

      setNewRecipeItems(prev => [
        ...prev,
        { foodId: foodIdNum, mode: 'amount', amount: amountNum },
      ]);
    }

    setRecipeFoodPickerId('');
    setRecipeFoodServings('1');
    setRecipeFoodQuantity('1');
    setRecipeFoodUnits('100');
    setRecipeIngredientSearch('');
  };


  const handleSaveRecipe = () => {
    const name = newRecipeName.trim();

    if (!name) {
      Alert.alert('Recipe name required', 'Please enter a recipe name.');
      return;
    }

    if (newRecipeItems.length === 0) {
      Alert.alert('No ingredients', 'Add at least one ingredient.');
      return;
    }

    const yieldNum = parseFloat(recipeYield);
    if (!Number.isFinite(yieldNum) || yieldNum <= 0) {
      Alert.alert('Invalid yield', 'Yield must be a positive number (e.g., 2).');
      return;
    }

    const finalWeightNum = parseFloat(recipeFinalWeight);
    const hasFinalWeight = Number.isFinite(finalWeightNum) && finalWeightNum > 0;

    // validate items
    for (const it of newRecipeItems) {
      const amt = Number(it.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        Alert.alert('Invalid amount', 'All ingredient amounts must be positive.');
        return;
      }

      const exists = foods.some((f) => f.id === Number(it.foodId));
      if (!exists) {
        Alert.alert('Missing food', 'One of the ingredients no longer exists in Food Library.');
        return;
      }

      if (it.mode === 'amount') {
        const food = foods.find(f => f.id === Number(it.foodId));
        const parsed = extractServingAmount(food?.servingSize);
        if (!parsed) {
          Alert.alert(
            'Amount not supported',
            'Serving size must be measurable or countable.'
          );
          return;
        }
      }
    }

    const payload = {
      name,
      yield: yieldNum,
      finalWeight: hasFinalWeight ? finalWeightNum : null,
      items: newRecipeItems.map((it) => ({
        foodId: Number(it.foodId),
        mode: it.mode || 'servings',
        amount: Number(it.amount),
      })),
    };



    if (editingRecipeId) {
      // update existing
      setRecipes((prev) =>
        prev.map((r) =>
          r.id === editingRecipeId ? { ...r, ...payload } : r
        )
      );
    } else {
      // create new
      setRecipes((prev) => [
        { id: Date.now(), ...payload },
        ...prev,
      ]);
    }

    setShowRecipeBuilder(false);
    resetRecipeBuilder();
  };


  // Convert an ingredient entry into "servings" (number)
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
      if (!parsed || !Number.isFinite(parsed.perServing) || parsed.perServing <= 0) {
        return NaN;
      }

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

  const mealTypes = ['breakfast', 'lunch', 'dinner', 'snacks'];

  const filteredRecipeFoods = useMemo(() => {
    const q = recipeIngredientSearch.trim().toLowerCase();
    if (!q) return foods;

    return foods.filter((f) => {
      const name = String(f.name || '').toLowerCase();
      const serving = String(f.servingSize || '').toLowerCase();
      return name.includes(q) || serving.includes(q);
    });
  }, [foods, recipeIngredientSearch]);

  const selectedRecipe = recipes.find((r) => r.id === Number(selectedRecipeId));

  const selectedRecipeHasWeight =
    Number.isFinite(Number(selectedRecipe?.finalWeight)) &&
    Number(selectedRecipe?.finalWeight) > 0;

  const filteredFoods = useMemo(() => {
    const q = foodSearch.trim().toLowerCase();
    if (!q) return foods;

    return foods.filter((f) => {
      const name = String(f.name || '').toLowerCase();
      const serving = String(f.servingSize || '').toLowerCase();
      return name.includes(q) || serving.includes(q);
    });
  }, [foods, foodSearch]);

  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    if (!q) return recipes;

    return recipes.filter((r) => {
      const nameMatch = String(r.name || '').toLowerCase().includes(q);

      // ingredient-name search (optional but 🔥)
      const ingredientMatch = (r.items || []).some((it) => {
        const food = foods.find(f => f.id === Number(it.foodId));
        return String(food?.name || '').toLowerCase().includes(q);
      });

      return nameMatch || ingredientMatch;
    });
  }, [recipeSearch, recipes, foods]);


  const totals = useMemo(() => {
    const dailyMeals = meals.filter(
      (m) => m.date === selectedDate && (m.enabled ?? true)
    );

    return dailyMeals.reduce(
      (acc, meal) => ({
        calories: acc.calories + (meal.calories || 0),
        protein: acc.protein + (meal.protein || 0),
        carbs: acc.carbs + (meal.carbs || 0),
        fats: acc.fats + (meal.fats || 0),
        sugar: acc.sugar + (meal.sugar || 0),
        addedSugar: acc.addedSugar + (meal.addedSugar || 0),
        sodium: acc.sodium + (meal.sodium || 0),
        fiber: acc.fiber + (meal.fiber || 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fats: 0, sugar: 0, addedSugar: 0, sodium: 0, fiber: 0 }
    );
  }, [meals, selectedDate]);

  const getMealsByType = (type) =>
    meals.filter((m) => m.date === selectedDate && m.mealType === type);

  const loggedDaysCount = useMemo(() => {
    const days = new Set(
      weekMeals.map((m) => m.date) // weekMeals already filtered to enabled + in-range
    );
    return Math.max(1, days.size);
  }, [weekMeals]);

  const weekTotals = useMemo(() => {
    return weekMeals.reduce(
      (acc, meal) => ({
        calories: acc.calories + (meal.calories || 0),
        protein: acc.protein + (meal.protein || 0),
        carbs: acc.carbs + (meal.carbs || 0),
        fats: acc.fats + (meal.fats || 0),
        sugar: acc.sugar + (meal.sugar || 0),
        addedSugar: acc.addedSugar + (meal.addedSugar || 0),
        sodium: acc.sodium + (meal.sodium || 0),
        fiber: acc.fiber + (meal.fiber || 0),
      }),
      {
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        sugar: 0,
        addedSugar: 0,
        sodium: 0,
        fiber: 0,
      }
    );
  }, [weekMeals]);


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

  // Fix timezone/day-shift bug by forcing local midnight parse
  const changeDate = (days) => {
    const date = new Date(selectedDate + 'T00:00:00');
    date.setDate(date.getDate() + days);
    setSelectedDate(date.toISOString().split('T')[0]);
  };

  const renderFoodItem = ({ item: food }) => (
    <View style={styles.foodItem}>
      {editingFood?.id === food.id ? (
        <View style={styles.editingContainer}>
          <TextInput
            style={styles.input}
            value={String(editingFood.name ?? '')}
            onChangeText={(text) => setEditingFood({ ...editingFood, name: text })}
            placeholder="Food name"
          />
          <TextInput
            style={styles.input}
            value={String(editingFood.servingSize ?? '')}
            onChangeText={(text) =>
              setEditingFood({ ...editingFood, servingSize: text })
            }
            placeholder="Serving size"
          />
          <View style={styles.macroEditGrid}>
            {['calories', 'protein', 'carbs', 'fats', 'sugar', 'addedSugar', 'sodium', 'fiber'].map(
              (field) => (
                <TextInput
                  key={field}
                  style={styles.macroInput}
                  value={String(editingFood[field] ?? '')}
                  onChangeText={(text) =>
                    setEditingFood({ ...editingFood, [field]: text })
                  }
                  placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                  keyboardType="numeric"
                />
              )
            )}
          </View>
          <View style={styles.editActions}>
            <Pressable onPress={handleUpdateFood} style={styles.iconButton}>
              <Ionicons name="checkmark" size={24} color="#10b981" />
            </Pressable>

            <Pressable onPress={() => setEditingFood(null)} style={styles.iconButton}>
              <Ionicons name="close" size={24} color="#6b7280" />
            </Pressable>
          </View>
        </View>

      ) : (
        <>
          <View style={styles.foodHeader}>
            <View style={styles.foodInfo}>
              <Text style={styles.foodName}>{food.name}</Text>
              <Text style={styles.foodServing}>{food.servingSize}</Text>
            </View>
            <View style={styles.foodActions}>
              <Pressable onPress={() => setEditingFood(food)} style={styles.iconButton}>
                <Ionicons name="create-outline" size={20} color="#3b82f6" />
              </Pressable>
              <Pressable onPress={() => handleDeleteFood(food.id)} style={styles.iconButton}>
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
        </>
      )}
    </View>
  );

  const selectedFood = foods.find((f) => f.id === Number(selectedFoodId));
  const selectedFoodUnit =
    extractServingUnit(selectedFood?.servingSize)?.unit || 'units';

  const recipeSelectedFood = foods.find((f) => f.id === Number(recipeFoodPickerId));
  const recipeSelectedUnit =
    extractServingUnit(recipeSelectedFood?.servingSize)?.unit || 'units';

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={foods}
        renderItem={renderFoodItem}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.pageContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <>
            <Text style={styles.title}>Meal Tracker</Text>

            <View style={styles.topActions}>
              <Pressable onPress={exportAllData} style={styles.exportButton}>
                <Ionicons name="download-outline" size={18} color="#fff" />
                <Text style={styles.exportButtonText}>Export data</Text>
              </Pressable>
              <Pressable onPress={importAllData} style={styles.exportButton}>
                <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                <Text style={styles.exportButtonText}>Import data</Text>
              </Pressable>

            </View>


            {/* Daily Summary */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Daily Summary</Text>
                <Pressable
                  onPress={() => setShowWeeklyStats(true)}
                  style={styles.weeklyButton}
                >
                  <Ionicons name="stats-chart-outline" size={18} color="#fff" />
                  <Text style={styles.weeklyButtonText}>Weekly</Text>
                </Pressable>
              </View>
              <View style={styles.summaryGrid}>
                <View style={[styles.summaryCard, { backgroundColor: '#fed7aa' }]}>
                  <Text style={styles.summaryLabel}>Calories</Text>
                  <Text style={styles.summaryValue}>{totals.calories.toFixed(0)}</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#fecaca' }]}>
                  <Text style={styles.summaryLabel}>Protein</Text>
                  <Text style={styles.summaryValue}>{totals.protein.toFixed(1)}g</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#fef08a' }]}>
                  <Text style={styles.summaryLabel}>Carbs</Text>
                  <Text style={styles.summaryValue}>{totals.carbs.toFixed(1)}g</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#e9d5ff' }]}>
                  <Text style={styles.summaryLabel}>Fats</Text>
                  <Text style={styles.summaryValue}>{totals.fats.toFixed(1)}g</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#fbcfe8' }]}>
                  <Text style={styles.summaryLabel}>Sugar</Text>
                  <Text style={styles.summaryValue}>{totals.sugar.toFixed(1)}g</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#bfdbfe' }]}>
                  <Text style={styles.summaryLabel}>Sodium</Text>
                  <Text style={styles.summaryValue}>{totals.sodium.toFixed(0)}mg</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#bfdbfe' }]}>
                  <Text style={styles.summaryLabel}>Fiber</Text>
                  <Text style={styles.summaryValue}>{totals.fiber.toFixed(0)}g</Text>
                </View>
                <View style={[styles.summaryCard, { backgroundColor: '#bfdbfe' }]}>
                  <Text style={styles.summaryLabel}>Added Sugar</Text>
                  <Text style={styles.summaryValue}>{totals.addedSugar.toFixed(0)}g</Text>
                </View>
              </View>
            </View>


            {/* Daily Meals */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <View style={styles.dateSelector}>
                  <Text style={styles.sectionTitle}>Daily Meals</Text>
                  <View style={styles.dateControls}>
                    <Pressable onPress={() => changeDate(-1)} style={styles.dateButton}>
                      <Ionicons name="chevron-back" size={24} color="#4f46e5" />
                    </Pressable>


                    <Text style={styles.dateText}>{selectedDate}</Text>
                    <Pressable onPress={() => changeDate(1)} style={styles.dateButton}>
                      <Ionicons name="chevron-forward" size={24} color="#4f46e5" />
                    </Pressable>
                  </View>
                </View>

                <Pressable
                  onPress={() => setShowAddMeal(true)}
                  style={[styles.addButton, { backgroundColor: '#10b981' }]}
                  disabled={foods.length === 0}
                >
                  <Ionicons name="add" size={20} color="#fff" />
                  <Text style={styles.addButtonText}>Log Meal</Text>
                </Pressable>
              </View>

              {mealTypes.map((type) => {
                const typeMeals = getMealsByType(type);
                if (typeMeals.length === 0) return null;

                return (
                  <View key={type} style={styles.mealTypeSection}>
                    <Text style={styles.mealTypeTitle}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>

                    {typeMeals.map((meal) => {

                      const displayMode = meal.mode || 'servings';
                      const displayAmount =
                        meal.amount != null
                          ? meal.amount
                          : (meal.servings != null ? meal.servings : 0);

                      return (
                        <View key={meal.id} style={[styles.mealItem, !(meal.enabled ?? true) && styles.mealItemDisabled]}>
                          <View style={styles.mealInfo}>
                            <Text style={styles.mealName}>{meal.foodName}</Text>
                            <Text style={styles.mealDetails}>
                              {meal.fromRecipe
                                ? (
                                  displayMode === 'amount'
                                    ? `${displayAmount.toFixed(0)} ${meal.amountLabel || 'units'}`
                                    : `${displayAmount.toFixed(1)} serving(s)`
                                ) + `${meal.recipeName ? ` • from ${meal.recipeName}` : ''}`
                                : (
                                  displayMode === 'amount'
                                    ? `${displayAmount.toFixed(0)} ${meal.amountLabel || 'units'}`
                                    : `${displayAmount.toFixed(1)} serving(s)`
                                )
                              } - {Number(meal.calories || 0).toFixed(0)} cal
                            </Text>

                          </View>
                          <View style={styles.mealActions}>
                            <Pressable
                              onPress={() => {
                                setSwapMeal(meal);
                                setSwapDate(meal.date); // prefill date in the popup
                                setSwapServings(String(meal.amount ?? meal.servings));
                              }}
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
                        </View>
                      );
                    })}
                  </View>
                );
              })}

              {meals.filter((m) => m.date === selectedDate).length === 0 && (
                <Text style={styles.emptyText}>No meals logged for this date yet.</Text>
              )}
            </View>

            {/* Recipe Library */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recipe Library</Text>

                <Pressable
                  onPress={() => {
                    setShowRecipeBuilder(true);
                    resetRecipeBuilder();
                  }}
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
                  {recipes.map((r) => (
                    <View key={r.id} style={styles.recipeCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recipeName}>{r.name}</Text>
                        <Text style={styles.recipeMeta}>
                          {r.items?.length ?? 0} ingredient(s)
                          {Number.isFinite(Number(r.finalWeight)) && Number(r.finalWeight) > 0
                            ? ` • ${r.finalWeight} g total`
                            : ''}
                        </Text>
                      </View>

                      <View style={styles.mealActions}>
                        <Pressable
                          onPress={() => {
                            // edit existing recipe
                            setShowRecipeBuilder(true);
                            // we’ll set builder state from recipe (step B below)
                            startEditingRecipe(r.id);
                          }}
                          style={styles.iconButton}
                        >
                          <Ionicons name="pencil-outline" size={20} color="#4f46e5" />
                        </Pressable>

                        <Pressable
                          onPress={() => confirmDeleteRecipe(r.id)}
                          style={styles.iconButton}
                        >
                          <Ionicons name="trash-outline" size={20} color="#ef4444" />
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>


            {/* Food Library header (foods are the FlatList rows) */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Food Library</Text>
                <Pressable onPress={() => setShowAddFood(true)} style={styles.addButton}>
                  <Ionicons name="add" size={20} color="#fff" />
                  <Text style={styles.addButtonText}>Add Food</Text>
                </Pressable>
              </View>

              {foods.length === 0 && (
                <Text style={styles.emptyText}>No foods yet — add your first one.</Text>
              )}
            </View>
          </>
        }
        ListFooterComponent={<View style={{ height: 24 }} />}
      />

      <Modal visible={showWeeklyStats} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Weekly Average</Text>

              <Pressable onPress={() => setShowWeeklyStats(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <Text style={{ color: '#6b7280', marginBottom: 12 }}>
              {weekStart} → {weekEnd}
            </Text>

            <Text style={{ color: '#6b7280', marginBottom: 12 }}>
              Based on {loggedDaysCount} logged day(s)
            </Text>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.summaryGrid}>
                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Calories</Text>
                  <Text style={styles.weekValue}>{weekAvg.calories.toFixed(0)}</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Protein</Text>
                  <Text style={styles.weekValue}>{weekAvg.protein.toFixed(1)}g</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Carbs</Text>
                  <Text style={styles.weekValue}>{weekAvg.carbs.toFixed(1)}g</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Fats</Text>
                  <Text style={styles.weekValue}>{weekAvg.fats.toFixed(1)}g</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Sugar</Text>
                  <Text style={styles.weekValue}>{weekAvg.sugar.toFixed(1)}g</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Added Sugar</Text>
                  <Text style={styles.weekValue}>{weekAvg.addedSugar.toFixed(1)}g</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Sodium</Text>
                  <Text style={styles.weekValue}>{weekAvg.sodium.toFixed(0)}mg</Text>
                </View>

                <View style={styles.weekCard}>
                  <Text style={styles.weekLabel}>Fiber</Text>
                  <Text style={styles.weekValue}>{weekAvg.fiber.toFixed(1)}g</Text>
                </View>
              </View>

              <View style={{ height: 12 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>


      {/* Add Food Modal */}
      <Modal visible={showAddFood} animationType="slide" transparent>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add New Food</Text>
              <Pressable onPress={() => setShowAddFood(false)}>
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TextInput
                style={styles.input}
                placeholder="Food name *"
                placeholderTextColor="#6b7280"
                value={newFood.name}
                onChangeText={(text) => setNewFood({ ...newFood, name: text })}
              />
              <TextInput
                style={styles.input}
                placeholder="Serving size (e.g., 1 cup, 100g)"
                placeholderTextColor="#6b7280"
                value={newFood.servingSize}
                onChangeText={(text) => setNewFood({ ...newFood, servingSize: text })}
              />
              <TextInput
                style={styles.input}
                placeholder="Calories *"
                placeholderTextColor="#6b7280"
                value={newFood.calories}
                onChangeText={(text) => setNewFood({ ...newFood, calories: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Protein (g)"
                placeholderTextColor="#6b7280"
                value={newFood.protein}
                onChangeText={(text) => setNewFood({ ...newFood, protein: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Carbs (g)"
                placeholderTextColor="#6b7280"
                value={newFood.carbs}
                onChangeText={(text) => setNewFood({ ...newFood, carbs: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Fats (g)"
                placeholderTextColor="#6b7280"
                value={newFood.fats}
                onChangeText={(text) => setNewFood({ ...newFood, fats: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Sugar (g)"
                placeholderTextColor="#6b7280"
                value={newFood.sugar}
                onChangeText={(text) => setNewFood({ ...newFood, sugar: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Added Sugar (g)"
                placeholderTextColor="#6b7280"
                value={newFood.addedSugar}
                onChangeText={(text) => setNewFood({ ...newFood, addedSugar: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Sodium (mg)"
                placeholderTextColor="#6b7280"
                value={newFood.sodium}
                onChangeText={(text) => setNewFood({ ...newFood, sodium: text })}
                keyboardType="numeric"
              />
              <TextInput
                style={styles.input}
                placeholder="Fiber (g)"
                placeholderTextColor="#6b7280"
                value={newFood.fiber}
                onChangeText={(text) => setNewFood({ ...newFood, fiber: text })}
                keyboardType="numeric"
              />

              <Pressable onPress={handleAddFood} style={[styles.addButton, styles.modalButton]}>
                <Text style={styles.addButtonText}>Add Food</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Meal Modal */}
      <Modal visible={showAddMeal} animationType="slide" transparent>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >

          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Log a Meal</Text>



              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Pressable onPress={() => {
                  Keyboard.dismiss()
                  setFoodSearch('');
                }}>

                </Pressable>

                <Pressable
                  onPress={() => {
                    setShowAddMeal(false);
                    setSelectedRecipeId('');
                    setRecipeSearch('')
                    setRecipeDraftItems([]);
                    setLogMode('food');
                    setRecipePortionsEaten('1'); // ✅ reset on close too
                  }}
                >

                  <Ionicons name="close" size={28} color="#6b7280" />
                </Pressable>
              </View>
            </View>

            {/* Scrollable content so inputs never get trapped behind keyboard */}
            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={{ paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >

              <View style={styles.pickerContainer}>
                <Text style={styles.pickerLabel}>Log Mode</Text>
                <View style={styles.pickerButtons}>
                  <Pressable
                    onPress={() => setLogMode('food')}
                    style={[
                      styles.pickerButton,
                      logMode === 'food' && styles.pickerButtonActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pickerButtonText,
                        logMode === 'food' && styles.pickerButtonTextActive,
                      ]}
                    >
                      Food
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setLogMode('recipe')}
                    style={[
                      styles.pickerButton,
                      logMode === 'recipe' && styles.pickerButtonActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pickerButtonText,
                        logMode === 'recipe' && styles.pickerButtonTextActive,
                      ]}
                    >
                      Recipe
                    </Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.modalForm}>
                <View style={styles.pickerContainer}>
                  <Text style={styles.pickerLabel}>Meal Type</Text>
                  <View style={styles.pickerButtons}>
                    {['breakfast', 'lunch', 'dinner', 'snacks'].map((type) => (
                      <Pressable
                        key={type}
                        onPress={() => setMealType(type)}
                        style={[
                          styles.pickerButton,
                          mealType === type && styles.pickerButtonActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.pickerButtonText,
                            mealType === type && styles.pickerButtonTextActive,
                          ]}
                        >
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>


                {/* ---------- FOOD MODE ---------- */}
                {logMode === 'food' && (
                  <>
                    <View style={styles.pickerContainer}>
                      <Text style={styles.pickerLabel}>Select Food</Text>

                      <TextInput
                        style={styles.searchInput}
                        placeholder="Search foods…"
                        placeholderTextColor="#6b7280"
                        value={foodSearch}
                        onChangeText={setFoodSearch}
                        returnKeyType="search"
                        clearButtonMode="while-editing" // iOS
                      />
                      <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                        {filteredFoods.map((f) => (
                          <Pressable
                            key={f.id}
                            onPress={() => setSelectedFoodId(String(f.id))}
                            style={[
                              styles.foodOption,
                              selectedFoodId === String(f.id) && styles.foodOptionActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.foodOptionText,
                                selectedFoodId === String(f.id) && styles.foodOptionTextActive,
                              ]}
                            >
                              {f.name}{f.servingSize ? ` • ${f.servingSize}` : ''}
                            </Text>
                          </Pressable>
                        ))}
                        {filteredFoods.length === 0 && (
                          <Text style={styles.emptySearchText}>No matches</Text>
                        )}
                      </ScrollView>
                    </View>

                    <View style={styles.pickerButtons}>
                      <Pressable
                        onPress={() => setMealInputMode('servings')}
                        style={[styles.pickerButton, mealInputMode === 'servings' && styles.pickerButtonActive]}
                      >
                        <Text style={[styles.pickerButtonText, mealInputMode === 'servings' && styles.pickerButtonTextActive]}>
                          Servings
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => setMealInputMode('amount')}
                        style={[styles.pickerButton, mealInputMode === 'amount' && styles.pickerButtonActive]}
                      >
                        <Text style={[styles.pickerButtonText, mealInputMode === 'amount' && styles.pickerButtonTextActive]}>
                          Amount
                        </Text>
                      </Pressable>
                    </View>

                    <TextInput
                      style={styles.input}
                      placeholder={
                        mealInputMode === 'amount'
                          ? 'Amount (e.g. 58, 240, 5)'
                          : 'Servings (e.g. 1, 0.5)'
                      }
                      placeholderTextColor="#6b7280"
                      value={mealAmount}
                      onChangeText={setMealAmount}
                      keyboardType="decimal-pad"
                      returnKeyType="done"
                      onSubmitEditing={Keyboard.dismiss}
                    />
                  </>
                )}

                {/* ---------- RECIPE MODE ---------- */}
                {logMode === 'recipe' && (
                  <>
                    <View style={styles.pickerButtons}>
                      <Pressable
                        onPress={() => setRecipeLogMode('portions')}
                        style={[
                          styles.pickerButton,
                          recipeLogMode === 'portions' && styles.pickerButtonActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.pickerButtonText,
                            recipeLogMode === 'portions' && styles.pickerButtonTextActive,
                          ]}
                        >
                          Portions
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          if (selectedRecipeHasWeight) setRecipeLogMode('weight');
                        }}
                        style={[
                          styles.pickerButton,
                          recipeLogMode === 'weight' && styles.pickerButtonActive,
                          !selectedRecipeHasWeight && { opacity: 0.5 },
                        ]}
                      >
                        <Text
                          style={[
                            styles.pickerButtonText,
                            recipeLogMode === 'weight' && styles.pickerButtonTextActive,
                          ]}
                        >
                          Weight
                        </Text>
                      </Pressable>
                    </View>

                    {recipeLogMode === 'weight' ? (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                          Weight Eaten (g)
                        </Text>

                        <TextInput
                          style={styles.input}
                          placeholder="e.g. 150"
                          value={recipeLoggedWeight}
                          onChangeText={setRecipeLoggedWeight}
                          keyboardType="decimal-pad"
                        />
                      </>
                    ) : (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                          Portions Eaten
                        </Text>

                        <TextInput
                          style={styles.input}
                          placeholder="e.g. 1.5"
                          value={recipePortionsEaten}
                          onChangeText={setRecipePortionsEaten}
                          keyboardType="decimal-pad"
                        />
                      </>
                    )}

                    <View style={styles.pickerContainer}>
                      <Text style={styles.pickerLabel}>Select Recipe</Text>

                      <TextInput
                        style={styles.searchInput}
                        placeholder="Search recipes…"
                        placeholderTextColor="#6b7280"
                        value={recipeSearch}
                        onChangeText={setRecipeSearch}
                      />
                      <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                        {filteredRecipes.map((r) => (
                          <Pressable
                            key={r.id}
                            onPress={() => startRecipeDraft(r.id)}
                            style={[
                              styles.foodOption,
                              selectedRecipeId === String(r.id) && styles.foodOptionActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.foodOptionText,
                                selectedRecipeId === String(r.id) && styles.foodOptionTextActive,
                              ]}
                            >
                              {r.name}
                            </Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </View>

                    {!!selectedRecipeId && (
                      <>
                        <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                          Ingredients
                        </Text>

                        {recipeDraftItems.map((it, idx) => {
                          const food = foods.find((f) => f.id === Number(it.foodId));
                          return (
                            <View key={`${it.foodId}-${idx}`} style={styles.mealItem}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.mealName}>
                                  {food ? food.name : 'Missing food'} • {
                                    it.mode === 'amount'
                                      ? `${it.amount} ${extractServingAmount(food?.servingSize)?.label || 'units'}`
                                      : `${it.amount} serving(s)`
                                  }
                                </Text>

                                <Text style={styles.recipeMeta}>
                                  {
                                    it.mode === 'amount'
                                      ? `${it.amount} ${extractServingAmount(food?.servingSize)?.label || 'units'}`
                                      : `${it.amount} serving(s)`
                                  } • 1 serving = {food?.servingSize || '—'}
                                </Text>

                                <TextInput
                                  style={[styles.input, { marginTop: 6 }]}
                                  value={String(it.amount ?? '')}
                                  onChangeText={(t) =>
                                    setRecipeDraftItems((prev) =>
                                      prev.map((x, i) =>
                                        i === idx ? { ...x, amount: t } : x
                                      )
                                    )
                                  }
                                  keyboardType="decimal-pad"
                                  placeholder={
                                    it.mode === 'amount'
                                      ? 'Amount'
                                      : 'Servings'
                                  }
                                  placeholderTextColor="#6b7280"
                                />
                              </View>

                              <Pressable
                                onPress={() =>
                                  setRecipeDraftItems((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                style={styles.iconButton}
                              >
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

            {/* Sticky bottom action bar (stays visible above keyboard) */}
            <View style={styles.modalBottomBar}>
              <Pressable
                onPress={logMode === 'recipe' ? handleLogRecipe : handleAddMeal}

                style={[styles.modalPrimaryButton, { backgroundColor: '#10b981' }]}
              >
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
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingRecipeId ? 'Edit Recipe' : 'Create Recipe'}
              </Text>

              <Pressable
                onPress={() => {
                  setShowRecipeBuilder(false);
                  resetRecipeBuilder();
                }}
              >
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TextInput
                style={styles.input}
                placeholder="Recipe name *"
                placeholderTextColor="#6b7280"
                value={newRecipeName}
                onChangeText={setNewRecipeName}
              />

              <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                Add ingredient
              </Text>



              <View style={{ gap: 10 }}>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search ingredients…"
                  placeholderTextColor="#6b7280"
                  value={recipeIngredientSearch}
                  onChangeText={setRecipeIngredientSearch}
                />

                <ScrollView style={styles.foodSelector} keyboardShouldPersistTaps="handled">
                  {filteredRecipeFoods.map((food) => (
                    <Pressable
                      key={food.id}
                      onPress={() => setRecipeFoodPickerId(String(food.id))}
                      style={[
                        styles.foodOption,
                        recipeFoodPickerId === String(food.id) && styles.foodOptionActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.foodOptionText,
                          recipeFoodPickerId === String(food.id) && styles.foodOptionTextActive,
                        ]}
                      >
                        {food.name}{food.servingSize ? ` • ${food.servingSize}` : ''}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                  Yield (portions)
                </Text>

                <TextInput
                  style={styles.input}
                  placeholder="Yield (portions)"
                  placeholderTextColor="#6b7280"
                  value={recipeYield}
                  onChangeText={setRecipeYield}
                  keyboardType="decimal-pad"
                />

                <Text style={[styles.pickerLabel, { marginTop: 12 }]}>
                  Final recipe weight
                </Text>

                <TextInput
                  style={styles.input}
                  placeholder="Final cooked weight (e.g. 580)"
                  placeholderTextColor="#6b7280"
                  value={recipeFinalWeight}
                  onChangeText={setRecipeFinalWeight}
                  keyboardType="decimal-pad"
                />

                <View style={styles.pickerButtons}>
                  <Pressable
                    onPress={() => setRecipeInputMode('servings')}
                    style={[styles.pickerButton, recipeInputMode === 'servings' && styles.pickerButtonActive]}
                  >
                    <Text style={[styles.pickerButtonText, recipeInputMode === 'servings' && styles.pickerButtonTextActive]}>
                      Servings
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setRecipeInputMode('amount')}
                    style={[styles.pickerButton, recipeInputMode === 'amount' && styles.pickerButtonActive]}
                  >
                    <Text style={[styles.pickerButtonText, recipeInputMode === 'amount' && styles.pickerButtonTextActive]}>
                      Amount
                    </Text>
                  </Pressable>
                </View>

                {recipeInputMode === 'servings' ? (
                  <TextInput
                    style={styles.input}
                    placeholder="Servings (e.g. 1, 0.5)"
                    placeholderTextColor="#6b7280"
                    value={recipeFoodServings}
                    onChangeText={setRecipeFoodServings}
                    keyboardType="decimal-pad"
                  />
                ) : (
                  <TextInput
                    style={styles.input}
                    placeholder={`${recipeSelectedUnit} (e.g. 100)`}
                    placeholderTextColor="#6b7280"
                    value={recipeFoodUnits}
                    onChangeText={setRecipeFoodUnits}
                    keyboardType="decimal-pad"
                  />
                )}


                <Pressable onPress={addIngredientToBuilder} style={[styles.addButton, { justifyContent: 'center' }]}>
                  <Text style={styles.addButtonText}>Add ingredient</Text>
                </Pressable>
              </View>

              {!!newRecipeItems.length && (
                <>
                  <Text style={[styles.pickerLabel, { marginTop: 16 }]}>
                    Ingredients
                  </Text>

                  {newRecipeItems.map((it, idx) => {
                    const food = foods.find(f => f.id === Number(it.foodId));
                    return (
                      <View key={`${it.foodId}-${idx}`} style={styles.mealItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.mealName}>
                            {food ? food.name : 'Missing food'} • {
                              it.mode === 'amount'
                                ? `${it.amount} ${extractServingAmount(food?.servingSize)?.label || 'units'}`
                                : `${it.amount} serving(s)`
                            }
                          </Text>

                          <Text style={styles.recipeMeta}>
                            {
                              it.mode === 'amount'
                                ? `${it.amount} ${extractServingAmount(food?.servingSize)?.label || 'units'}`
                                : `${it.amount} serving(s)`
                            } • 1 serving = {food?.servingSize || '—'}
                          </Text>

                          <TextInput
                            style={[styles.input, { marginTop: 6 }]}
                            value={String(it.amount ?? '')}
                            onChangeText={(t) =>
                              setNewRecipeItems(prev =>
                                prev.map((x, i) => (i === idx ? { ...x, amount: t } : x))
                              )
                            }
                            keyboardType="decimal-pad"
                            placeholder={
                              it.mode === 'amount'
                                ? 'Amount'
                                : 'Servings'
                            }
                            placeholderTextColor="#6b7280"
                          />
                        </View>

                        <Pressable
                          onPress={() => setNewRecipeItems(prev => prev.filter((_, i) => i !== idx))}
                          style={styles.iconButton}
                        >
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


      <Modal visible={!!swapMeal} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '70%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit logged meal</Text>
              <Pressable
                onPress={() => {
                  setSwapMeal(null);
                  setSwapDate('');
                }}
              >
                <Ionicons name="close" size={28} color="#6b7280" />
              </Pressable>
            </View>

            <Text style={{ marginBottom: 12, color: '#374151' }}>
              {swapMeal ? swapMeal.foodName : ''}
            </Text>

            {/* ✅ Meal type switch (same as before) */}
            <Text style={{ marginBottom: 8, color: '#374151', fontWeight: '600' }}>
              Move to meal type
            </Text>
            <View style={styles.pickerButtons}>
              {['breakfast', 'lunch', 'dinner', 'snacks'].map((type) => {
                const active = swapMeal?.mealType === type;
                return (
                  <Pressable
                    key={type}
                    onPress={() => saveSwapChanges(type)}   // ✅ SAVE now updates type + date
                    style={[styles.pickerButton, active && styles.pickerButtonActive]}
                  >
                    <Text
                      style={[
                        styles.pickerButtonText,
                        active && styles.pickerButtonTextActive,
                      ]}
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* ✅ Date change controls */}
            <Text style={{ marginTop: 16, marginBottom: 8, color: '#374151', fontWeight: '600' }}>
              Move to date
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Pressable onPress={() => shiftSwapDate(-1)} style={styles.dateChip}>
                <Ionicons name="chevron-back" size={18} color="#4f46e5" />
                <Text style={styles.dateChipText}>-1</Text>
              </Pressable>

              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={swapDate}
                onChangeText={setSwapDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#6b7280"
                autoCapitalize="none"
              />

              <Pressable onPress={() => shiftSwapDate(1)} style={styles.dateChip}>
                <Text style={styles.dateChipText}>+1</Text>
                <Ionicons name="chevron-forward" size={18} color="#4f46e5" />
              </Pressable>
            </View>

            <Text style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Tip: Tap a meal type above to save changes.
            </Text>

            <Text style={{ marginTop: 16, marginBottom: 6, color: '#374151', fontWeight: '600' }}>
              {swapMeal?.mode === 'amount'
                ? (swapMeal?.amountLabel || 'amount')
                : 'Servings'}
            </Text>

            <TextInput
              style={styles.input}
              value={swapServings}
              onChangeText={setSwapServings}
              keyboardType="decimal-pad"
              placeholder={
                swapMeal?.mode === 'amount'
                  ? (swapMeal?.amountLabel || 'amount')
                  : 'Servings'
              }
              placeholderTextColor="#6b7280"
            />

          </View>
        </View>
      </Modal>


    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f9ff' },

  // ✅ required by FlatList contentContainerStyle
  pageContent: { paddingBottom: 24 },

  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#1f2937',
    textAlign: 'center',
    marginVertical: 20,
  },
  section: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: '#374151' },
  addButton: {
    backgroundColor: '#4f46e5',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 8,
  },
  addButtonText: { color: '#fff', fontWeight: '600' },

  emptyText: { color: '#6b7280', fontSize: 13 },

  foodItem: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
  },
  foodHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  foodInfo: { flex: 1 },
  foodName: { fontSize: 16, fontWeight: '600', color: '#1f2937' },
  foodServing: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  foodActions: { flexDirection: 'row', gap: 8 },
  iconButton: { padding: 4 },

  macroGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  macroText: { fontSize: 12, color: '#4b5563', width: '30%' },

  editingContainer: { gap: 8 },

  // ✅ gray-ish input background (your request)
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    backgroundColor: '#f3f4f6',
    color: '#111827',
  },

  macroEditGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  macroInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
    width: '30%',
    backgroundColor: '#f3f4f6',
    color: '#111827',
  },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },

  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  summaryCard: { width: '47%', padding: 16, borderRadius: 8 },
  summaryLabel: { fontSize: 12, fontWeight: '500', color: '#78350f' },
  summaryValue: { fontSize: 28, fontWeight: 'bold', color: '#78350f', marginTop: 4 },

  dateSelector: { flex: 1 },
  dateControls: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 12 },
  dateButton: { padding: 4 },
  dateText: { fontSize: 14, color: '#4b5563', fontWeight: '500' },

  mealTypeSection: { marginTop: 16 },
  mealTypeTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingBottom: 8,
    marginBottom: 12,
  },
  mealItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  mealInfo: { flex: 1 },
  mealName: { fontSize: 14, fontWeight: '500', color: '#1f2937' },
  mealDetails: { fontSize: 12, color: '#6b7280', marginTop: 2 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    width: '90%',
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: '600' },
  modalScroll: { maxHeight: 500 },
  modalForm: { gap: 12 },
  modalButton: { width: '100%', marginTop: 8, justifyContent: 'center' },

  pickerContainer: { marginBottom: 12 },
  pickerLabel: { fontSize: 14, fontWeight: '500', color: '#374151', marginBottom: 8 },
  pickerButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickerButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  pickerButtonActive: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  pickerButtonText: { fontSize: 14, color: '#6b7280' },
  pickerButtonTextActive: { color: '#fff', fontWeight: '600' },

  foodSelector: { maxHeight: 150, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8 },
  foodOption: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  foodOptionActive: { backgroundColor: '#dbeafe' },
  foodOptionText: { fontSize: 14, color: '#374151' },
  foodOptionTextActive: { fontWeight: '600', color: '#1e40af' },

  modalBottomBar: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },

  modalPrimaryButton: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },

  modalPrimaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },

  topActions: {
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },

  exportButton: {
    flex: 1,                // 👈 makes both buttons same width
    backgroundColor: '#111827',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center', // 👈 centers icon+text inside
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },


  exportButtonText: {
    color: '#fff',
    fontWeight: '700',
  },

  mealActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  mealItemDisabled: {
    opacity: 0.45,
  },

  dateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
  },
  dateChipText: {
    color: '#4f46e5',
    fontWeight: '700',
  },

  recipeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  recipeName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  recipeMeta: {
    marginTop: 2,
    fontSize: 12,
    color: '#6b7280',
  },

  weeklyButton: {
    backgroundColor: '#111827',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },

  weeklyButtonText: {
    color: '#fff',
    fontWeight: '700',
  },

  weekCard: {
    width: '47%',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  weekLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
  },
  weekValue: {
    marginTop: 6,
    fontSize: 20,
    color: '#111827',
    fontWeight: '800',
  },

  searchInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: '#f3f4f6',
    color: '#111827',
    marginBottom: 10,
  },

  emptySearchText: {
    padding: 12,
    color: '#6b7280',
    fontSize: 13,
  },



});
