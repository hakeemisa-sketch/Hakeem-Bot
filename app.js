const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main webhook handler
app.post('/whatsapp/webhook', async (req, res) => {
  console.log('📨 Webhook received:', {
    from: req.body.From,
    body: req.body.Body,
    timestamp: new Date().toISOString()
  });

  const phoneNumber = req.body.From?.replace('whatsapp:', '') || '';
  const userMessage = req.body.Body?.trim().toUpperCase() || '';

  try {
    // 1. Load or create processor record
    let processor = await getOrCreateProcessor(phoneNumber);
    console.log(`👤 Processor: ${processor.id}, Status: ${processor.status}`);

    // 2. Route by current state
    let responseText = '';

    if (processor.status === 'ONBOARDING') {
      // User just started — show greeting and ask for first input
      if (userMessage === 'START') {
        responseText = await generateOnboardingResponse(processor);
        processor.status = 'PRE_QUAL';
        processor.pre_qual_question = 1;
        await updateProcessorStatus(processor);
      } else {
        responseText = 'Hi! 👋 I\'m Hakeem. Type START to begin learning how to reduce post-harvest losses and increase your income.';
      }
    }
    else if (processor.status === 'PRE_QUAL') {
      // Processing pre-qualification answers
      const questionNumber = processor.pre_qual_question || 1;

      if (questionNumber <= 5) {
        // Save this answer
        await savePreQualAnswer(processor.id, questionNumber, userMessage);

        // If on Q5, calculate tier and move to teaching
        if (questionNumber === 5) {
          const tier = await calculateTier(processor.id);
          const score = await calculateLeadScore(processor.id);

          processor.tier = tier;
          processor.lead_type = score > 12 ? 'hot' : score > 9 ? 'warm' : 'cold';
          processor.status = 'TEACHING';
          processor.pre_qual_score = score;

          await updateProcessorStatus(processor);

          responseText = await generateTeachingStartMessage(processor, tier, score);
          console.log(`✅ Tier detected: ${tier} (Score: ${score})`);
        } else {
          // Move to next question
          processor.pre_qual_question = questionNumber + 1;
          await updateProcessorStatus(processor);

          responseText = await generatePreQualQuestion(processor.pre_qual_question, processor);
        }
      }
    }
    else if (processor.status === 'TEACHING') {
      // Teaching mode — pass to Claude with tier context
      responseText = await generateTeachingResponse(processor, userMessage);
    }
    else if (processor.status === 'SOFT_CONA_INTRO') {
      // Soft CONA introduction
      responseText = await generateSoftConaMessage(processor, userMessage);
    }
    else if (processor.status === 'CONA_SALES') {
      // CONA sales conversation
      responseText = await generateConaSalesResponse(processor, userMessage);
    }
    else {
      responseText = 'Hi! 👋 I\'m Hakeem. Type START to begin.';
    }

    // 3. Send response via Twilio
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE}`,
      to: `whatsapp:${phoneNumber}`,
      body: responseText
    });

    console.log(`✅ Message sent to ${phoneNumber}`);
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    res.status(500).send('Error');
  }
});

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

async function getOrCreateProcessor(phoneNumber) {
  let { data, error } = await supabase
    .from('processors')
    .select('*')
    .eq('phone', phoneNumber)
    .single();

  if (error || !data) {
    // Create new processor
    const { data: newProcessor, error: createError } = await supabase
      .from('processors')
      .insert([{
        phone: phoneNumber,
        status: 'ONBOARDING',
        contact_date: new Date().toISOString(),
        pre_qual_question: 1
      }])
      .select()
      .single();

    if (createError) throw createError;
    return newProcessor;
  }

  return data;
}

async function updateProcessorStatus(processor) {
  const { error } = await supabase
    .from('processors')
    .update({
      status: processor.status,
      tier: processor.tier,
      lead_type: processor.lead_type,
      pre_qual_question: processor.pre_qual_question,
      pre_qual_score: processor.pre_qual_score
    })
    .eq('id', processor.id);

  if (error) throw error;
}

async function savePreQualAnswer(processorId, questionNumber, answer) {
  const { error } = await supabase
    .from('pre_qual_answers')
    .insert([{
      processor_id: processorId,
      question_number: questionNumber,
      answer: answer,
      answered_at: new Date().toISOString()
    }]);

  if (error) throw error;
}

async function calculateTier(processorId) {
  const { data: answers, error } = await supabase
    .from('pre_qual_answers')
    .select('question_number, answer')
    .eq('processor_id', processorId);

  if (error || !answers || answers.length === 0) {
    return 'TIER_1'; // Default
  }

  let totalScore = 0;
  let maxScore = 0;

  answers.forEach(({ question_number, answer }) => {
    const score = scoreAnswer(question_number, answer);
    totalScore += score;
    maxScore = Math.max(maxScore, score);
  });

  // Tier detection logic (from engine spec)
  if (maxScore === 3 && totalScore >= 12) {
    return 'TIER_3';
  } else if (maxScore === 2 || (totalScore >= 9 && totalScore <= 12)) {
    return 'TIER_2';
  } else {
    return 'TIER_1';
  }
}

async function calculateLeadScore(processorId) {
  const { data: answers } = await supabase
    .from('pre_qual_answers')
    .select('question_number, answer')
    .eq('processor_id', processorId);

  if (!answers) return 6;

  let totalScore = 0;
  answers.forEach(({ question_number, answer }) => {
    totalScore += scoreAnswer(question_number, answer);
  });

  return totalScore;
}

function scoreAnswer(questionNumber, answer) {
  const answerUpper = String(answer).toUpperCase();

  if (questionNumber === 1) {
    // Q1: What crops?
    if (answerUpper.includes('TOMATO') || answerUpper.includes('PEPPER')) {
      return answerUpper.includes('EXPORT') || answerUpper.includes('RESTAURANT') ? 3 : 1;
    }
    return 2; // Multiple crops
  }

  if (questionNumber === 2) {
    // Q2: Spoilage %?
    if (answerUpper.includes('50') || answerUpper.includes('HIGH') || answerUpper.includes('HALF')) {
      return 1; // >20%
    } else if (answerUpper.includes('30') || answerUpper.includes('MODERATE')) {
      return 2; // 10-20%
    } else if (answerUpper.includes('10') || answerUpper.includes('LOW')) {
      return 3; // <10%
    }
    return 1;
  }

  if (questionNumber === 3) {
    // Q3: Loss type?
    if (answerUpper.includes('MOLD') || answerUpper.includes('RAIN') || answerUpper.includes('PEST')) {
      return 1; // Environmental
    } else if (answerUpper.includes('STORAGE') || answerUpper.includes('TIME')) {
      return 2; // Storage-related
    } else if (answerUpper.includes('FLAVOR') || answerUpper.includes('EXPORT') || answerUpper.includes('CERT')) {
      return 3; // Technical/export
    }
    return 1;
  }

  if (questionNumber === 4) {
    // Q4: Space?
    if (answerUpper.includes('NO') || answerUpper.includes('NONE')) {
      return 1;
    } else if (answerUpper.includes('MAYBE') || answerUpper.includes('CORNER') || answerUpper.includes('RENT')) {
      return 2;
    } else if (answerUpper.includes('YES') || answerUpper.includes('FACILITY') || answerUpper.includes('DEDICATED')) {
      return 3;
    }
    return 1;
  }

  if (questionNumber === 5) {
    // Q5: What would spoilage reduction mean?
    if (answerUpper.includes('MONEY') || answerUpper.includes('FAMILY')) {
      return 1;
    } else if (answerUpper.includes('EXPAND') || answerUpper.includes('HIRE') || answerUpper.includes('GROW')) {
      return 2;
    } else if (answerUpper.includes('EXPORT') || answerUpper.includes('CERT') || answerUpper.includes('YEAR-ROUND')) {
      return 3;
    }
    return 1;
  }

  return 1;
}

// ============================================================================
// MESSAGE GENERATION FUNCTIONS
// ============================================================================

async function generateOnboardingResponse(processor) {
  return `Hi! 👋 I'm Hakeem.

I teach crop drying free. Not theory—stuff that works on African farms to stop you losing money to spoilage.

Let me ask you 5 quick questions so I can teach you exactly what fits your situation.

**Question 1: What do you dry most?**
(e.g., Tomatoes, Peppers, Mangoes, Cassava, Ginger...)`;
}

async function generatePreQualQuestion(questionNumber, processor) {
  const questions = [
    `**Question 1: What do you dry most?**\n(e.g., Tomatoes, Peppers, Mangoes, Cassava, Ginger...)`,

    `**Question 2: In a typical month, how much spoils before you sell?**\n(Rough %, or compare: Out of 10 bags, how many end up wasted?)`,

    `**Question 3: What's your main loss?**\n(Mold, Pests, Rot, Rejected by customers...)`,

    `**Question 4: Do you have space for a small setup?**\n(Corner of your room, cupboard, part of your store...)`,

    `**Question 5: If spoilage dropped by half this month, what would that mean?**\n(More money? More time? Tell me honestly.)`
  ];

  return questions[questionNumber - 1] || 'Thank you for your responses! Let me analyze...';
}

async function generateTeachingStartMessage(processor, tier, score) {
  const tierLabel = tier === 'TIER_1' ? 'Micro-Scale' : tier === 'TIER_2' ? 'Small Commercial' : 'Commercial Scale';
  const leadType = processor.lead_type === 'hot' ? '🔥 Hot' : processor.lead_type === 'warm' ? '🔥 Warm' : 'Building';

  return `✅ Perfect! I've got a clear picture now. ${leadType} lead.

You're a **${tierLabel}** processor. Here's what we'll do:

**Week 1:** Stop the mold (storage method that meets FAO standards) — costs ₦15k or less
**Week 2-3:** Measure if it works
**Week 4+:** Upgrade if needed

This method has worked for farmers in Lagos, Ibadan, and Nairobi. You'll feel the difference in 7 days.

Ready to start? Type **YES** and I'll send you Week 1, Day 1.`;
}

async function generateTeachingResponse(processor, userMessage) {
  // For now, return a simple response
  // In production, this would call Claude API with tier-based system prompt

  if (userMessage === 'YES') {
    return `💪 Great. Week 1 starts now.

**STOP THE MOLD: Storage Method (FAO-Recommended)**

The #1 way to stop spoilage is: keep crops dry.

Think of it like this: Leave a wet cloth in a plastic bag for 2 days. It smells bad, gets mold. Your dried crops do the same if moisture is trapped inside.

Solution: **Hermetic Airtight Bags + Silica Gel**

I partner with GrainPro for premium airtight bags. Use code **HAKEEM_[YOUR_NAME]15** at grainpro.com — you get 15% off.

Also get food-grade silica gel packets — they pull moisture out so mold can't grow.

**Your challenge this week:**
1. Order bags + silica (today)
2. Dry your first batch (Day 4)
3. Check for mold + take a photo (Day 7)

Send me a photo Day 7. That's how you know it works.

Questions?`;
  }

  return `Thanks for that. What's your next question about the method?`;
}

async function generateSoftConaMessage(processor, userMessage) {
  return `You've proven the FAO method works. Want to speed it up 10x? CONA solar dryers do this automatically.

More next week.`;
}

async function generateConaSalesResponse(processor, userMessage) {
  return `CONA dryer details coming soon.`;
}

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Hakeem Bot running on port ${PORT}`);
});