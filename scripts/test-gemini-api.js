const { GoogleGenerativeAI } = require('@google/generative-ai');

// Check for API key
const API_KEY = process.env.GEMINI_API_KEY;

console.log('\n🔍 Testing Gemini API Connection...\n');

if (!API_KEY) {
  console.error('❌ GEMINI_API_KEY not set!');
  console.error('\nTo set your API key:');
  console.error('  export GEMINI_API_KEY="your-api-key-here"\n');
  console.error('Get your API key from: https://aistudio.google.com/app/apikey\n');
  process.exit(1);
}

console.log('✓ API key found');
console.log(`  Length: ${API_KEY.length} characters`);
console.log(`  Preview: ${API_KEY.substring(0, 10)}...${API_KEY.substring(API_KEY.length - 4)}\n`);

// Test the API
async function testAPI() {
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

    console.log('🔄 Testing API with a simple prompt...\n');

    const result = await model.generateContent('Say "Hello from Gemini!" and nothing else.');
    const response = await result.response;
    const text = response.text();

    console.log('✅ API Response:');
    console.log(`   ${text}\n`);
    console.log('🎉 Gemini API is working correctly!\n');
    console.log('You can now run the image comparison:');
    console.log('  node scripts/compare-images-gemini.js\n');

  } catch (err) {
    console.error('❌ API Test Failed:');
    console.error(`   ${err.message}\n`);

    if (err.message.includes('API_KEY_INVALID')) {
      console.error('Your API key appears to be invalid.');
      console.error('Get a new one from: https://aistudio.google.com/app/apikey\n');
    } else if (err.message.includes('quota')) {
      console.error('You may have exceeded your API quota.');
      console.error('Check your quota at: https://console.cloud.google.com/\n');
    } else {
      console.error('Full error:', err);
    }

    process.exit(1);
  }
}

testAPI();
