/**
 * Test Pipeline Debugger
 * Run with: node lib/test-pipeline.js
 */

const VideoPipelineDebugger = require('./video-pipeline-debugger');
const fs = require('fs');
const path = require('path');

async function testPipeline() {
  console.log('🎬 Video Pipeline Debugger Test');
  console.log('='.repeat(60));

  const pipeline = new VideoPipelineDebugger();

  // For testing, use a demo video path
  // In real usage, this would be an uploaded file
  const testVideoPath = '/tmp/test-video.mp4'; // Placeholder
  const testVideoId = `test_${Date.now()}`;

  console.log(`\n📹 Processing: ${testVideoId}`);
  console.log(`Video path: ${testVideoPath}`);

  try {
    // In real scenario, this would be an actual uploaded video
    // For now, we simulate the pipeline stages

    console.log('\n[STAGE 1] Extracting metadata...');
    const metadata = {
      path: testVideoPath,
      sizeKB: 5000,
      durationSeconds: 45,
      filename: 'test-gaming-short.mp4',
      ok: true
    };
    pipeline.log('stage_1_metadata', metadata);

    console.log('\n[STAGE 2] Detecting scenes...');
    const scenes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45];
    pipeline.log('stage_2_scenes', { scenes, count: scenes.length });

    console.log('\n[STAGE 3] Computing motion scores...');
    const motionSegments = [
      { start: 0, end: 5, duration: 5, motionIntensity: 45, confidence: 0.7 },
      { start: 5, end: 10, duration: 5, motionIntensity: 72, confidence: 0.8 },
      { start: 10, end: 15, duration: 5, motionIntensity: 38, confidence: 0.6 },
      { start: 15, end: 20, duration: 5, motionIntensity: 88, confidence: 0.9 },
      { start: 20, end: 25, duration: 5, motionIntensity: 55, confidence: 0.7 },
    ];
    pipeline.log('stage_3_motion', { segments: motionSegments.length });

    console.log('\n[STAGE 4] Detecting audio peaks...');
    const audioPeaks = [
      { timestamp: 3, intensity: 0.75 },
      { timestamp: 17, intensity: 0.92 },
      { timestamp: 35, intensity: 0.68 }
    ];
    pipeline.log('stage_4_audio', { peaks: audioPeaks.length });

    console.log('\n[STAGE 5] Scoring segments...');
    const scoredSegments = pipeline.scoreSegments(motionSegments, audioPeaks);
    console.log(`✓ Scored ${scoredSegments.length} segments`);

    console.log('\n[STAGE 6] Extracting highlights...');
    const highlights = pipeline.extractHighlights(scoredSegments);
    console.log(`✓ Extracted ${highlights.length} highlights`);
    if (highlights.length === 0) {
      console.error('❌ ERROR: No highlights returned!');
      return;
    }

    console.log('\n[STAGE 7] Generating variants...');
    const variants = pipeline.generateVariants(highlights);
    console.log(`✓ Generated ${variants.length} variants`);
    if (variants.length === 0) {
      console.error('❌ ERROR: No variants generated!');
      return;
    }

    console.log('\n[STAGE 8] Computing crop...');
    const crop = pipeline.computeCrop();
    console.log(`✓ Crop: ${crop.width}x${crop.height} at (${crop.x}, ${crop.y})`);

    console.log('\n[STAGE 9] Generating subtitles...');
    const subtitles = pipeline.generateSubtitles(variants);
    console.log(`✓ Subtitles for ${Object.keys(subtitles).length} variants`);

    console.log('\n[STAGE 10] Preparing render...');
    const bestVariant = variants.sort((a, b) => b.score - a.score)[0];
    const renderConfig = pipeline.prepareRender(testVideoPath, bestVariant, crop);

    console.log('\n✅ PIPELINE SUCCESS');
    console.log('='.repeat(60));
    console.log('\nRender Configuration:');
    console.log(JSON.stringify(renderConfig, null, 2));

    console.log('\n📊 Pipeline Stages:');
    pipeline.stages.forEach((stage, idx) => {
      console.log(`  ${idx + 1}. ${stage.stage} (${stage.duration}ms)`);
    });

    // Validate final output
    console.log('\n🔍 Final Validation:');
    const checks = [
      { name: 'Render config exists', ok: !!renderConfig },
      { name: 'Segments array non-empty', ok: renderConfig.segments && renderConfig.segments.length > 0 },
      { name: 'Crop valid', ok: renderConfig.crop && renderConfig.crop.width > 0 },
      { name: 'Video path set', ok: !!renderConfig.videoPath },
      { name: 'Variant selected', ok: !!renderConfig.variant }
    ];

    let allPassed = true;
    checks.forEach(check => {
      const status = check.ok ? '✓' : '✗';
      console.log(`  ${status} ${check.name}`);
      if (!check.ok) allPassed = false;
    });

    if (allPassed) {
      console.log('\n✨ ALL CHECKS PASSED - Video is ready to render!');
    } else {
      console.error('\n❌ Some checks failed');
    }

  } catch (error) {
    console.error('\n❌ Pipeline error:', error.message);
    console.error(error.stack);
  }
}

// Run test
testPipeline().catch(console.error);
