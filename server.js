const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const levenshtein = require("fast-levenshtein");
const ExcelJS = require("exceljs");
require("dotenv").config();

// ========== [환경 설정] ==========
const {
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  DB_NAME,
  MONGODB_URI,
  CAFE24_MALLID,
  OPEN_URL,
  API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo",
  CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

// ========== [Express 초기화] ==========
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [글로벌 상태] ==========
let combinedSystemPrompt = null;
let pendingCoveringContext = false;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) {
  return promptText
    .replace(/\[카카오플친 연결하기\]/g, '<a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank">카카오플친 연결하기</a>')
    .replace(/\[네이버톡톡 연결하기\]/g, '<a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank">네이버톡톡 연결하기</a>');
}

const basePrompt = `
1. 역할 및 말투  
전문가 역할: 샐리필 브랜드에 대한 전문 지식을 가진 전문가로 행동합니다.  
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.  
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.  
문단 띄어쓰기: 각 문단이 끝날 때마다 한 줄 이상의 공백을 넣어 가독성을 높여 주세요.
맞춤법 다음문장에서는 문단 공백을 통해 가독성을 높여 주세요.

2. 고객 응대 지침  
정확한 답변: 웹상의 모든 요기보 관련 데이터를 숙지하고, 고객 문의에 대해 명확하고 이해하기 쉬운 답변을 제공해 주세요.  
아래 JSON 데이터는 참고용 포스트잇 Q&A 데이터입니다. 이 데이터를 참고하여 적절한 답변을 생성해 주세요.

3. 항상 모드 대화의 마지막엔 추가 궁금한 사항이 있으실 경우, 상담사 연결을 채팅창에 입력 해주시면 보다 정확한 정보를 제공해 드릴수 있습니다. 
`;
const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
const companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));

// MongoDB에서 토큰을 저장할 컬렉션명
const tokenCollectionName = "tokens";

// ========== [3] MongoDB 토큰 관리 함수 ==========
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    const tokensDoc = await collection.findOne({});
    if (tokensDoc) {
      accessToken = tokensDoc.accessToken;
      refreshToken = tokensDoc.refreshToken;
      console.log('MongoDB에서 토큰 로드 성공:', tokensDoc);
    } else {
      console.log('MongoDB에 저장된 토큰이 없습니다. 초기 토큰을 저장합니다.');
      await saveTokensToDB(accessToken, refreshToken);
    }
  } catch (error) {
    console.error('토큰 로드 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    await collection.updateOne(
      {},
      {
        $set: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log('MongoDB에 토큰 저장 완료');
  } catch (error) {
    console.error('토큰 저장 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function refreshAccessToken() {
  console.log('401 에러 발생: MongoDB에서 토큰 정보 다시 가져오기...');
  await getTokensFromDB();
  console.log('MongoDB에서 토큰 갱신 완료:', accessToken, refreshToken);
  return accessToken;
}

// ========== [4] Cafe24 API 요청 함수 ==========
async function apiRequest(method, url, data = {}, params = {}) {
  console.log(`Request: ${method} ${url}`);
  console.log("Params:", params);
  console.log("Data:", data);
  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('Access Token 만료. 갱신 중...');
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    } else {
      console.error('API 요청 오류:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}


// ========== [5] Cafe24 주문/배송 관련 함수 ==========
async function getOrderShippingInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  const today = new Date();
  const end_date = today.toISOString().split('T')[0];
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);
  const start_date = twoWeeksAgo.toISOString().split('T')[0];
  const params = {
    member_id: memberId,
    start_date: start_date,
    end_date: end_date,
    limit: 10,
  };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    return response; // 응답 내 orders 배열
  } catch (error) {
    console.error("Error fetching order shipping info:", error.message);
    throw error;
  }
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  const params = { shop_no: 1 };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      // 배송사 코드에 따른 이름과 링크 매핑
      const shippingCompanies = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/index" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/index.do" }
      };
      if (shippingCompanies[shipment.shipping_company_code]) {
        shipment.shipping_company_name = shippingCompanies[shipment.shipping_company_code].name;
        shipment.shipping_company_url = shippingCompanies[shipment.shipping_company_code].url;
      } else {
        shipment.shipping_company_name = shipment.shipping_company_code || "물류 창고";
        shipment.shipping_company_url = null;
      }
      return shipment;
    } else {
      throw new Error("배송 정보를 찾을 수 없습니다.");
    }
  } catch (error) {
    console.error("Error fetching shipment detail:", error.message);
    throw error;
  }
}


// ========== [10] 대화 로그 저장 함수 (당일 동일 아이디 대화는 배열로 업데이트) ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    // 오늘 날짜 (YYYY-MM-DD)
    const today = new Date().toISOString().split("T")[0];
    const query = {
      memberId: (memberId && memberId !== "null") ? memberId : null,
      date: today
    };
    const existingLog = await collection.findOne(query);
    const logEntry = {
      userMessage,
      botResponse,
      createdAt: new Date()
    };
    if (existingLog) {
      await collection.updateOne(query, { $push: { conversation: logEntry } });
      console.log("대화 로그 업데이트 성공");
    } else {
      await collection.insertOne({
        memberId: (memberId && memberId !== "null") ? memberId : null,
        date: today,
        conversation: [logEntry]
      });
      console.log("새 대화 로그 생성 및 저장 성공");
    }
  } catch (error) {
    console.error("대화 로그 저장 중 오류:", error.message);
  } finally {
    await client.close();
  }
}

// ========== [GPT 호출 함수] ==========
async function getGPT3TurboResponse(userInput) {
  if (!combinedSystemPrompt) {
    throw new Error("System prompt가 초기화되지 않았습니다.");
  }

  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: combinedSystemPrompt },
          { role: "user", content: userInput }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const gptAnswer = response.data.choices[0].message.content;
    return addSpaceAfterPeriod(gptAnswer);

  } catch (error) {
    console.error("OpenAI API 오류:", error.message);
    return "요기보 챗봇 오류가 발생했습니다. 다시 시도 부탁드립니다.";
  }
}

// ========== [도우미 함수] ==========
function addSpaceAfterPeriod(text) {
  return text.replace(/\.([^\s])/g, '. $1');
}

function normalizeSentence(sentence) {
  return sentence.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim();
}

function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// ========== [시스템 프롬프트 생성 - Post-it 포함] ==========
async function initializeChatPrompt() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const sallyPostItNotes = await db.collection("sallyPostItNotes").find({}).limit(100).toArray();

    let sallyPostItContext = "\n아래는 참고용 포스트잇 Q&A 데이터입니다:\n";
    sallyPostItNotes.forEach(note => {
      if (note.question && note.answer) {
        sallyPostItContext += `\n질문: ${note.question}\n답변: ${note.answer}\n`;
      }
    });

    return YOGIBO_SYSTEM_PROMPT + sallyPostItContext;
  } catch (err) {
    console.error("Post-it 로딩 오류:", err);
    return YOGIBO_SYSTEM_PROMPT;
  } finally {
    await client.close();
  }
}


// ========== [대화 로그 저장] ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  const today = new Date().toISOString().split("T")[0];
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const logs = db.collection("sallyfeelDataLoding");

    const logEntry = {
      userMessage,
      botResponse,
      createdAt: new Date()
    };

    await logs.updateOne(
      { memberId: memberId || null, date: today },
      { $push: { conversation: logEntry } },
      { upsert: true }
    );
  } finally {
    await client.close();
  }
}


// ========== [Chat 요청 처리] ==========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId;

  if (!userInput) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const normalizedInput = normalizeSentence(userInput);

    let responseText;

    // 👉 FAQ, 주문/배송, sallyPostIt 기반 응답 시도
    const answer = await findAnswer(normalizedInput, memberId);

    // fallback 응답일 경우 GPT 호출
    if (answer?.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptText = await getGPT3TurboResponse(userInput);
      responseText = {
        text: gptText,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    } else {
      responseText = answer;
    }

    // 내 아이디 요청은 로그 저장 안함
    if (normalizedInput !== "내 아이디") {
      await saveConversationLog(memberId, userInput, responseText.text);
    }

    return res.json(responseText);

  } catch (error) {
    console.error("/chat 처리 중 오류:", error);
    return res.status(500).json({
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    });
  }
});


// ========== [13] 대화 내용 Excel 다운로드 라우팅 ==========
app.get('/chatConnet', async (req, res) => {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    const data = await collection.find({}).toArray();

    // 새로운 Excel 워크북과 워크시트 생성
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('ConversationList');

    // 워크시트 컬럼 헤더 설정
    worksheet.columns = [
      { header: '회원아이디', key: 'memberId', width: 15 },
      { header: '날짜', key: 'date', width: 15 },
      { header: '대화내용', key: 'conversation', width: 50 },
    ];

    // 각 문서마다 한 행씩 추가 (conversation 배열은 JSON 문자열로 변환)
    data.forEach(doc => {
      worksheet.addRow({
        memberId: doc.memberId || '비회원',
        date: doc.date,
        conversation: JSON.stringify(doc.conversation, null, 2)
      });
    });

    // 응답 헤더 설정 후 워크북을 스트림으로 전송 (Excel 다운로드)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=conversationLogs.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Excel 파일 생성 중 오류:", error.message);
    res.status(500).send("Excel 파일 생성 중 오류가 발생했습니다.");
  } finally {
    await client.close();
  }
});


// ========== [6] 포스트잇 CRUD ==========
app.get("/sallyPostIt", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const PAGE_SIZE = 300;
  const category = req.query.category;
  const queryFilter = category ? { category } : {};

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("sallyPostItNotes");

    const totalCount = await collection.countDocuments(queryFilter);
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    const currentPage = Math.max(1, Math.min(page, totalPages || 1));
    const skipCount = (currentPage - 1) * PAGE_SIZE;

    const notes = await collection.find(queryFilter)
      .sort({ _id: -1 })
      .skip(skipCount)
      .limit(PAGE_SIZE)
      .toArray();

    notes.forEach(doc => doc._id = doc._id.toString());

    await client.close();
    return res.json({ notes, currentPage, totalPages, totalCount, pageSize: PAGE_SIZE });
  } catch (error) {
    console.error("GET /sallyPostIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 목록 조회 중 오류가 발생했습니다." });
  }
});

app.post("/sallyPostIt", async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question && !answer) {
    return res.status(400).json({ error: "질문 또는 답변이 비어있습니다." });
  }

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("sallyPostItNotes");

    const newNote = {
      question,
      answer: convertHashtagsToLinks(answer),
      category: category || "uncategorized",
      createdAt: new Date()
    };

    await collection.insertOne(newNote);
    await client.close();

    combinedSystemPrompt = await initializeChatPrompt();

    return res.json({ message: "포스트잇 등록 성공 및 프롬프트 갱신 완료 ✅", note: newNote });
  } catch (error) {
    console.error("POST /sallyPostIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 등록 중 오류가 발생했습니다." });
  }
});

app.put("/sallyPostIt/:id", async (req, res) => {
  try {
    const noteId = req.params.id;
    const { question, answer, category } = req.body;

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("sallyPostItNotes");

    const filter = { _id: new ObjectId(noteId) };
    const updateData = {
      ...(question && { question }),
      ...(answer && { answer: convertHashtagsToLinks(answer) }),
      ...(category && { category }),
      updatedAt: new Date()
    };

    const result = await collection.findOneAndUpdate(
      filter,
      { $set: updateData },
      { returnDocument: "after" }
    );

    await client.close();

    if (!result.value) {
      return res.status(404).json({ error: "해당 포스트잇을 찾을 수 없습니다." });
    }

    combinedSystemPrompt = await initializeChatPrompt();

    return res.json({ message: "포스트잇 수정 성공 및 프롬프트 갱신 완료 ✅", note: result.value });
  } catch (error) {
    console.error("PUT /sallyPostIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 수정 중 오류가 발생했습니다." });
  }
});

app.delete("/sallyPostIt/:id", async (req, res) => {
  const noteId = req.params.id;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("sallyPostItNotes");

    const result = await collection.deleteOne({ _id: new ObjectId(noteId) });
    await client.close();

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "삭제할 포스트잇을 찾지 못했습니다." });
    }

    return res.json({ message: "포스트잇 삭제 성공" });
  } catch (error) {
    console.error("DELETE /sallyPostIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 삭제 중 오류가 발생했습니다." });
  }
});


// ========== [서버 실행 및 프롬프트 초기화] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작 중...");

    // 토큰 불러오기
    await getTokensFromDB();

    // 시스템 프롬프트 한 번만 초기화
    combinedSystemPrompt = await initializeChatPrompt();

    console.log("✅ 시스템 프롬프트 초기화 완료");

    // 서버 실행
    app.listen(PORT, () => {
      console.log(`🚀 서버 실행 완료! 포트: ${PORT}`);
    });

  } catch (err) {
    console.error("❌ 서버 초기화 오류:", err.message);
    process.exit(1);
  }
})();
