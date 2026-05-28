const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { upsertGoal, deleteGoal, getGoalWithProgress, getGoalsHistory } = require('../controllers/goalsController');

router.get('/history',  authMiddleware, getGoalsHistory);
router.get('/:month',   authMiddleware, getGoalWithProgress);
router.post('/',        authMiddleware, upsertGoal);
router.delete('/:month',authMiddleware, deleteGoal);

module.exports = router;
