
lucide.createIcons();

    let currentUser = null;
    let cachedQueue = [];
    let collectedSymptoms = []; 
    let collectedHistory = []; 
    let conversationHistory = [];
    let latestSymptomSummary = ''; 
    let latestHistorySummary = '';
    let latestDepartment = '';
    let latestDoctorName = '';
    let latestUrgency = 'ROUTINE';
    let latestPriorityLevel = 3;
    let selectedQueueId = null;
    let selectedPatientId = null;
    let patientId = null;
    let abhaLinked = false;
    let consultationType = 'FRESH';
    let followUpOfTriageId = null;
    let recorder = null;
    let isRecording = false;
    let currentStream = null;

    // ---auto-stop recording---
    let vadAudioContext = null;
    let vadAnalyser = null;
    let vadIntervalId = null;
    const VAD_SILENCE_RMS_THRESHOLD = 0.02; // below this = "silence"
    const VAD_SILENCE_STOP_MS = 1500;       // stop after this much continuous silence, once speech was heard
    const VAD_MAX_RECORDING_MS = 20000;     // hard safety cap so it can never record forever

    // --- view changer---
  let viewHistory = [];
let currentView = 'landing'; // jo bhi tumhara default view hai

function switchView(viewName, fromBack = false) {
  // fromBack=true tabhi hota hai jab goBack() khud is function ko call kare —
  // us case me history me dobara push nahi karna warna infinite loop jaisi
  // behavior ban jayega (back dabao toh wahi page phir history me chala jaye).
  if (!fromBack && currentView !== viewName) {
    viewHistory.push(currentView);
  }
  currentView = viewName;

  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  const activePanel = document.getElementById(`view-${viewName}`);
  const activeTab = document.getElementById(`tab-${viewName}`);

  if (activePanel) activePanel.classList.add('active');
  if (activeTab) activeTab.classList.add('active');

  if (viewName === 'doctor') {
    fetchLiveDoctorQueue();
  }

  updateBackButtonVisibility();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.lucide) lucide.createIcons();
}

function goBack() {
  if (viewHistory.length === 0) return;
  const previousView = viewHistory.pop();
  switchView(previousView, true);
}

function updateBackButtonVisibility() {
  const backBtn = document.getElementById('global-back-btn');
  if (!backBtn) return;
  backBtn.style.display = viewHistory.length > 0 ? 'inline-flex' : 'none';
}

    // --- audio recording(auto-stops on silence) ---
    async function toggleVoiceInput() {
      if (isRecording) {
        stopRecordingAndProcess();
        return;
      }
      await startRecording();
    }

    async function startRecording() {
      const micBtn = document.getElementById('mic-btn');
      const indicator = document.getElementById('speech-status-indicator');

      try {
        currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = RecordRTC(currentStream, {
          type: 'audio',
          mimeType: 'audio/wav',
          recorderType: StereoAudioRecorder,
          desiredSampRate: 16000
        });
        recorder.startRecording();
        isRecording = true;

        micBtn.classList.add('recording-pulse');
        indicator.innerText = "🔴 Listening... it'll send automatically once you stop talking.";
        indicator.style.color = "var(--danger)";

        startSilenceDetection(currentStream);
      } catch (err) {
        console.error("Mic error:", err);
        indicator.innerText = "⚠️ Microphone permission denied.";
        indicator.style.color = "var(--danger)";
      }
    }

    function startSilenceDetection(stream) {
      stopSilenceDetection();

      vadAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = vadAudioContext.createMediaStreamSource(stream);
      vadAnalyser = vadAudioContext.createAnalyser();
      vadAnalyser.fftSize = 512;
      source.connect(vadAnalyser);

      const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);
      const recordingStartedAt = Date.now();
      let hasHeardSpeech = false;
      let silenceStartedAt = null;

      vadIntervalId = setInterval(() => {
        vadAnalyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);

        if (rms > VAD_SILENCE_RMS_THRESHOLD) {
          hasHeardSpeech = true;
          silenceStartedAt = null;
        } else if (hasHeardSpeech) {
          if (silenceStartedAt === null) silenceStartedAt = Date.now();
          else if (Date.now() - silenceStartedAt > VAD_SILENCE_STOP_MS) {
            stopRecordingAndProcess();
            return;
          }
        }

        if (Date.now() - recordingStartedAt > VAD_MAX_RECORDING_MS) {
          stopRecordingAndProcess();
        }
      }, 150);
    }

    function stopSilenceDetection() {
      if (vadIntervalId) { clearInterval(vadIntervalId); vadIntervalId = null; }
      if (vadAudioContext) { vadAudioContext.close(); vadAudioContext = null; }
      vadAnalyser = null;
    }

    function stopRecordingAndProcess() {
      if (!isRecording || !recorder) return;
      stopSilenceDetection();

      const micBtn = document.getElementById('mic-btn');
      const indicator = document.getElementById('speech-status-indicator');

      recorder.stopRecording(async function() {
        let blob = recorder.getBlob();
        isRecording = false;
        micBtn.classList.remove('recording-pulse');
        indicator.innerText = "⏳ Uploading and processing voice on server...";
        indicator.style.color = "var(--warning)";

        
        if (currentStream) {
          currentStream.getTracks().forEach(track => track.stop());
          currentStream = null;
        }

        const formData = new FormData();
        formData.append('file', blob, 'voice.wav');
        formData.append('language', document.getElementById('p-login-lang').value);
        formData.append('history', JSON.stringify(conversationHistory));

        try {
          const response = await fetch('https://medikiosk-backend-fqof.onrender.com/api/ai/voice-chat', {
            method: 'POST',
            body: formData
          });
          const data = await response.json();

          if (!response.ok) {
            console.error('Voice chat error:', data.detail);
            indicator.innerText = `⚠️ ${data.detail || 'Server error processing voice.'}`;
            indicator.style.color = "var(--danger)";
            return;
          }

          if (data.transcript && data.transcript !== "Audio unclear.") {
            if (data.symptom_type === 'MEDICAL_HISTORY') {
              collectedHistory.push(data.transcript);
            } else {
              collectedSymptoms.push(data.transcript);
            }
            document.getElementById('chat-input').value = data.transcript;
            appendChatMessage(data.transcript, 'user');
            conversationHistory.push({ role: 'user', text: data.transcript });
          }

          conversationHistory.push({ role: 'model', text: data.reply });
          if (data.symptom_summary) latestSymptomSummary = data.symptom_summary;
          if (data.history_summary) latestHistorySummary = data.history_summary;

          appendChatMessage(data.reply, 'bot');
          speakText(data.reply);

          if (data.ready_for_triage) {
            latestDepartment = data.matched_department;
            latestDoctorName = data.doctor_name;
            latestUrgency = data.urgency;
            latestPriorityLevel = data.priority_level;
            document.getElementById('match-doc-title').innerText = data.doctor_name;
            document.getElementById('match-reason-text').innerText = `Department: ${data.matched_department} • Urgency: Level ${data.priority_level}`;
            document.getElementById('ai-match-card').style.display = 'block';
          }

          indicator.innerText = "🎙️ Voice processed successfully.";
          indicator.style.color = "var(--success)";
        } catch (err) {
          console.error(err);
          indicator.innerText = "⚠️ Server error processing voice. Is FastAPI running?";
          indicator.style.color = "var(--danger)";
        }
      });
    }

    // --- text to speech ---
    function speakText(text) {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const langChoice = document.getElementById('p-login-lang').value;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = (langChoice === 'Hindi') ? 'hi-IN' : 'en-IN';
      utterance.rate = 0.95;
      
      const voices = window.speechSynthesis.getVoices();
      const targetLang = (langChoice === 'Hindi') ? 'hi' : 'en';
      const voice = voices.find(v => v.lang.startsWith(targetLang));
      if (voice) utterance.voice = voice;
      
      window.speechSynthesis.speak(utterance);
    }

    function updateSelectedLanguage() {
      const lang = document.getElementById('p-login-lang').value;
      const welcome = document.getElementById('bot-welcome-msg');
      if (lang === 'English') {
        welcome.innerText = "Hello! What symptoms or health concerns are you experiencing today?";
      } else {
        welcome.innerText = "नमस्ते! आपको क्या तकलीफ़ है? बोलकर या लिखकर बताएं।";
      }
    }

    // --- chat handler ---
    async function sendChatMessage() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;

      appendChatMessage(text, 'user');
      input.value = '';

      const langChoice = document.getElementById('p-login-lang').value;

      try {
        const response = await fetch('https://medikiosk-backend-fqof.onrender.com/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, language: langChoice, history: conversationHistory })
        });

        const data = await response.json();

        if (!response.ok) {
          appendChatMessage(data.detail || 'Something went wrong. Please try again.', 'bot');
          return;
        }

        if (data.symptom_type === 'MEDICAL_HISTORY') {
          collectedHistory.push(text);
        } else {
          collectedSymptoms.push(text);
        }

        conversationHistory.push({ role: 'user', text: text });
        conversationHistory.push({ role: 'model', text: data.reply });
        if (data.symptom_summary) latestSymptomSummary = data.symptom_summary;
        if (data.history_summary) latestHistorySummary = data.history_summary;

        appendChatMessage(data.reply, 'bot');
        speakText(data.reply);

        if (data.ready_for_triage) {
          latestDepartment = data.matched_department;
          latestDoctorName = data.doctor_name;
          latestUrgency = data.urgency;
          latestPriorityLevel = data.priority_level;
          document.getElementById('match-doc-title').innerText = data.doctor_name;
          document.getElementById('match-reason-text').innerText = `Department: ${data.matched_department} • Urgency: Priority Level ${data.priority_level}`;
          document.getElementById('ai-match-card').style.display = 'block';
        }

      } catch (err) {
        console.error("AI Endpoint Error:", err);
        appendChatMessage('Could not reach the server. Please check your connection and try again.', 'bot');
      }
    }

    function appendChatMessage(msg, type) {
      const chatBox = document.getElementById('ai-chat-history');
      const div = document.createElement('div');
      div.className = `chat-msg ${type}`;
      div.innerText = msg;
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    // --- choose identifier type + auth method ---
    let loginIdentifierType = 'MOBILE';
    let loginAuthMethod = 'OTP';        

    function selectLoginIdentifier(type) {
      loginIdentifierType = type;

      const mobileBtn = document.getElementById('id-type-mobile-btn');
      const abhaBtn = document.getElementById('id-type-abha-btn');
      mobileBtn.classList.toggle('btn-primary', type === 'MOBILE');
      mobileBtn.classList.toggle('btn-secondary', type !== 'MOBILE');
      abhaBtn.classList.toggle('btn-primary', type === 'ABHA');
      abhaBtn.classList.toggle('btn-secondary', type !== 'ABHA');

      const label = document.getElementById('login-identifier-label');
      const prefix = document.getElementById('login-identifier-prefix');
      const input = document.getElementById('login-identifier-input');

      if (type === 'MOBILE') {
        label.innerText = 'Mobile Number / फ़ोन नंबर';
        prefix.style.display = '';
        input.placeholder = '9876543210';
        input.maxLength = 10;
        input.value = '9876543210';
      } else {
        label.innerText = 'ABHA Number / ABHA Address';
        prefix.style.display = 'none';
        input.placeholder = '14-1234-5678-9012 or name@abdm';
        input.removeAttribute('maxlength');
        input.value = '';
      }
    }

    function selectLoginMethod(method) {
      loginAuthMethod = method;

      const otpBtn = document.getElementById('auth-method-otp-btn');
      const pwdBtn = document.getElementById('auth-method-password-btn');
      otpBtn.classList.toggle('btn-primary', method === 'OTP');
      otpBtn.classList.toggle('btn-secondary', method !== 'OTP');
      pwdBtn.classList.toggle('btn-primary', method === 'PASSWORD');
      pwdBtn.classList.toggle('btn-secondary', method !== 'PASSWORD');

      document.getElementById('login-password-field').style.display = method === 'PASSWORD' ? 'block' : 'none';

      const submitBtn = document.getElementById('login-submit-btn');
      submitBtn.innerHTML = method === 'OTP'
        ? 'Send 4-Digit OTP <i data-lucide="arrow-right" style="width:16px;"></i>'
        : 'Sign In <i data-lucide="log-in" style="width:16px;"></i>';
      lucide.createIcons();
    }

    function submitLoginCredentials() {
      const identifier = document.getElementById('login-identifier-input').value.trim();
      if (!identifier) {
        alert(loginIdentifierType === 'MOBILE' ? 'Please enter a valid mobile number.' : 'Please enter your ABHA number or address.');
        return;
      }
      if (loginIdentifierType === 'MOBILE' && identifier.length < 10) {
        alert('Please enter a valid 10-digit mobile number.');
        return;
      }

      if (loginAuthMethod === 'PASSWORD') {
        authenticateWithPassword(identifier);
      } else {
        showLoginStep('login-otp-step');
      }
    }

    async function authenticateWithPassword(identifier) {
      const pwd = document.getElementById('login-password-input').value;
      if (!pwd) { alert('Please enter your password.'); return; }

      // Also send name/DOB needed only if this mobile number is brand new, in which
      // case the backend registers the account on the spot (same as the OTP flow does).
      const nameVal = document.getElementById('login-name-input').value.trim();
      const dobVal = document.getElementById('login-dob-input').value; // "" or "YYYY-MM-DD"

      try {
        const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/patient/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobile: identifier,
            password: pwd,
            full_name: nameVal || undefined,
            dob: dobVal || undefined
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.detail || 'Invalid mobile number or password.');
          return;
        }
        finishLogin(identifier, data);
      } catch (err) {
        console.error('Password authentication failed:', err);
        alert('Could not reach the server to sign in.');
      }
    }

    async function verifyLoginOTP() {
      const otp = document.getElementById('login-otp-input').value.trim();
      if (otp !== '4321') {
        alert('Invalid OTP. Use demo OTP: 4321');
        return;
      }
      const identifier = document.getElementById('login-identifier-input').value.trim();
      const nameVal = document.getElementById('login-name-input').value.trim();
      const dobVal = document.getElementById('login-dob-input').value; // "" or "YYYY-MM-DD"

      try {
        const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/patient/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile: identifier, full_name: nameVal || undefined, dob: dobVal || undefined })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // brand new mobile number with no DOB supplied yet.
          alert(data.detail || 'Please enter your date of birth to finish setting up your account.');
          return;
        }
        finishLogin(identifier, data);
      } catch (err) {
        console.error('Patient login failed:', err);
        alert('Could not reach the server to sign in.');
      }
    }

    // Shared by both the OTP path and the password path 
    function finishLogin(identifier, data) {
  const authPhone = document.getElementById('p-auth-phone');
  if (authPhone) authPhone.value = identifier;

  currentUser = { role: 'PATIENT', name: data.full_name || 'Patient' };
  patientId = data.patient_id ?? null;
  abhaLinked = !!data.abha_linked;

  if (loginIdentifierType === 'ABHA') abhaLinked = true;

  updateAuthUI();

  if (abhaLinked) {
    switchView('patient');
    goToPatientStep(0);
  } else {
    // ABHA link mandatory step dikhayein
    switchView('patient-login');
    showLoginStep('abha-mandatory-step');
  }
}

    // Shows one step of the patient-login/ABHA card and hides the rest.
    function showLoginStep(stepId) {
      const steps = [
        'login-select-step', 'login-otp-step', 'abha-mandatory-step',
        'abha-link-step', 'abha-link-otp-step',
        'abha-create-step', 'abha-create-otp-step', 'abha-success-step'
      ];
      steps.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === stepId) ? 'block' : 'none';
      });
      lucide.createIcons();
    }

    // --- ABHA link-existing aur create-new ---
    function showAbhaLinkExisting() { showLoginStep('abha-link-step'); }
    function showAbhaCreate() { showLoginStep('abha-create-step'); }

    function sendAbhaLinkOTP() {
      const val = document.getElementById('abha-link-input').value.trim();
      if (!val) { alert('Please enter your ABHA Number or ABHA Address.'); return; }
      showLoginStep('abha-link-otp-step');
    }

    function verifyAbhaLinkOTP() {
      const otp = document.getElementById('abha-link-otp-input').value.trim();
      if (otp !== '4321') { alert('Invalid OTP. Use demo OTP: 4321'); return; }
      const abhaVal = document.getElementById('abha-link-input').value.trim();
      document.getElementById('abha-success-number').innerText = abhaVal;
      document.getElementById('abha-success-address').innerText = abhaVal.includes('@') ? abhaVal : `${abhaVal.replace(/-/g, '')}@abdm`;
      showLoginStep('abha-success-step');
    }

    function sendAbhaCreateOTP() {
      const name = document.getElementById('abha-create-name').value.trim();
      const mobile = document.getElementById('abha-create-mobile').value.trim();
      if (!name || mobile.length < 10) { alert('Please fill in your name and a valid Aadhaar-linked mobile number.'); return; }
      showLoginStep('abha-create-otp-step');
    }

    function verifyAbhaCreateOTP() {
      const otp = document.getElementById('abha-create-otp-input').value.trim();
      if (otp !== '4321') { alert('Invalid OTP. Use demo OTP: 4321'); return; }
      const generatedNumber = '14-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000);
      const nameVal = document.getElementById('abha-create-name').value.trim().toLowerCase().replace(/\s+/g, '');
      document.getElementById('abha-success-number').innerText = generatedNumber;
      document.getElementById('abha-success-address').innerText = `${nameVal || 'patient'}@abdm`;
      showLoginStep('abha-success-step');
    }

    async function finalizeAbhaAndProceed() {
  abhaLinked = true;

  if (patientId) {
    const abhaNumber = document.getElementById('abha-success-number')?.innerText || "";
    const abhaAddress = document.getElementById('abha-success-address')?.innerText || "";
    try {
      await fetch('https://medikiosk-backend-fqof.onrender.com/api/patient/link-abha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId, abha_number: abhaNumber, abha_address: abhaAddress })
      });
    } catch (err) {
      console.error('Saving ABHA link failed:', err);
    }
  }

  switchView('patient');
  goToPatientStep(0);
}

    function delinkAbha() {
      if (!patientId) { alert('No linked patient profile found.'); return; }
      if (!confirm('Delink your ABHA ID? You will need to link it again before your next visit.')) return;

      fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientId}/delink-abha`, { method: 'POST' })
        .then(res => res.json())
        .then(() => {
          abhaLinked = false;
          alert('ABHA ID delinked from your profile.');
          switchView('patient-login');
          showLoginStep('abha-mandatory-step');
        })
        .catch(err => {
          console.error('Delink ABHA failed:', err);
          alert('Could not delink ABHA ID — please try again.');
        });
    }

    function updateAbhaStatusDisplay() {
      const el = document.getElementById('abha-status-text');
      if (el) el.innerText = abhaLinked ? 'Yes ✅' : 'No';
    }

    function togglePasswordReset() {
      const form = document.getElementById('password-reset-form');
      form.style.display = (form.style.display === 'none') ? 'block' : 'none';
    }

    async function submitPasswordReset() {
      if (!patientId) { alert('No profile found — please log in again.'); return; }
      const current = document.getElementById('reset-current-password').value;
      const next = document.getElementById('reset-new-password').value;
      if (!current || !next) { alert('Please fill in both fields.'); return; }

      try {
        const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientId}/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: current, new_password: next })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.detail || 'Could not update password.'); return; }

        alert('Password updated successfully.');
        document.getElementById('reset-current-password').value = '';
        document.getElementById('reset-new-password').value = '';
        togglePasswordReset();
      } catch (err) {
        console.error('Password reset failed:', err);
        alert('Could not reach the server to update password.');
      }
    }

    function selectConsultationType(type) {
      consultationType = type;
      document.getElementById('consult-type-fresh-card').style.borderColor = (type === 'FRESH') ? 'var(--primary)' : 'var(--border)';
      document.getElementById('consult-type-followup-card').style.borderColor = (type === 'FOLLOWUP') ? 'var(--primary)' : 'var(--border)';

      if (type === 'FRESH') {
        followUpOfTriageId = null;
        document.getElementById('followup-history-picker').style.display = 'none';
        goToPatientStep(1);
      } else {
        document.getElementById('followup-history-picker').style.display = 'block';
        loadPastConsultations();
      }
    }

    async function loadPastConsultations() {
      const list = document.getElementById('followup-history-list');
      list.innerHTML = '<p style="font-size:0.8rem; color:var(--text-muted);">Loading past visits…</p>';

      if (!patientId) {
        list.innerHTML = '<p style="font-size:0.8rem; color:var(--text-muted);">No profile on record yet — this will be logged as a follow-up without a linked past visit.</p>';
        return;
      }

      try {
        const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientId}/consultations`);
        const data = await res.json();
        const consultations = data.consultations || [];

        if (!consultations.length) {
          list.innerHTML = '<p style="font-size:0.8rem; color:var(--text-muted);">No past visits found on record — you can still continue as a follow-up.</p>';
          return;
        }

        list.innerHTML = '';
        consultations.forEach(c => {
          let dept = 'General Medicine';
          try {
            const summary = typeof c.ai_structured_summary === 'string' ? JSON.parse(c.ai_structured_summary) : c.ai_structured_summary;
            if (summary && summary.department) dept = summary.department;
          } catch (e) { /* keep default */ }

          const dateStr = c.created_at ? new Date(c.created_at).toLocaleDateString() : 'Date unknown';

          const item = document.createElement('div');
          item.className = 'queue-item';
          item.innerHTML = `<strong>${dept}</strong><p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.15rem;">${dateStr}</p>`;
          item.onclick = () => {
            followUpOfTriageId = c.triage_session_id;
            document.querySelectorAll('#followup-history-list .queue-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
          };
          list.appendChild(item);
        });
      } catch (err) {
        console.error('Past consultations fetch error:', err);
        list.innerHTML = '<p style="font-size:0.8rem; color:var(--text-muted);">Could not load past visits — you can still continue.</p>';
      }
    }

    function proceedToIntake() {
      goToPatientStep(1);
    }

    async function loginDoctor() {
      const staffId = document.getElementById('doc-id-input').value.trim();
      const pwd = document.getElementById('doc-pwd-input').value;
      if (!staffId || !pwd) { alert('Please enter your Staff ID and password.'); return; }

      try {
        const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/doctor/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ staff_id: staffId, password: pwd })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.detail || 'Invalid Staff ID or password.'); return; }

        currentUser = { role: 'DOCTOR', name: data.full_name, doctorId: data.doctor_id };
        updateAuthUI();
        switchView('doctor');
      } catch (err) {
        console.error('Doctor login failed:', err);
        alert('Could not reach the server to sign in.');
      }
    }

    function toggleDoctorPasswordReset() {
      const form = document.getElementById('doctor-password-reset-form');
      form.style.display = (form.style.display === 'none') ? 'block' : 'none';
    }

    async function submitDoctorPasswordReset() {
      if (!currentUser || !currentUser.doctorId) { alert('Please sign in again.'); return; }
      const current = document.getElementById('doc-reset-current-password').value;
      const next = document.getElementById('doc-reset-new-password').value;
      if (!current || !next) { alert('Please fill in both fields.'); return; }

      try {
        const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/doctor/${currentUser.doctorId}/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: current, new_password: next })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.detail || 'Could not update password.'); return; }

        alert('Password updated successfully.');
        document.getElementById('doc-reset-current-password').value = '';
        document.getElementById('doc-reset-new-password').value = '';
        toggleDoctorPasswordReset();
      } catch (err) {
        console.error('Doctor password reset failed:', err);
        alert('Could not reach the server to update password.');
      }
    }

    function updateAuthUI() {
      const userPill = document.getElementById('user-pill');
      const displayName = document.getElementById('user-display-name');
      if (currentUser) {
        userPill.style.display = 'flex';
        displayName.innerText = `${currentUser.name} (${currentUser.role})`;
      } else {
        userPill.style.display = 'none';
      }
    }

    function logoutUser() {
      currentUser = null;
      patientId = null;
      abhaLinked = false;
      consultationType = 'FRESH';
      followUpOfTriageId = null;
      updateAuthUI();
      showLoginStep('login-select-step');
      document.getElementById('login-otp-input').value = '';
      selectLoginIdentifier('MOBILE');
      selectLoginMethod('OTP');
      switchView('landing');
    }

    function goToPatientStep(stepNumber) {
  [0, 1, 2, 3].forEach(num => {
    const el = document.getElementById(`patient-step-${num}`);
    if (el) el.style.display = (num === stepNumber) ? 'block' : 'none';
  });

  if (stepNumber === 0) updateAbhaStatusDisplay();
  if (window.lucide) lucide.createIcons();
}

    let selectedOCRFile = null;

//User ke document lete hi image preview dikhayein
function handleImageSelection(event) {
  const file = event.target.files[0];
  if (!file) return;

  selectedOCRFile = file;

  const reader = new FileReader();
  reader.onload = function (e) {
    document.getElementById('image-preview').src = e.target.result;
    document.getElementById('image-preview-container').style.display = 'block';
    document.getElementById('ocr-results').style.display = 'none';
    lucide.createIcons();
  };
  reader.readAsDataURL(file);
}

//Image ko FastAPI backend par bhejkar Gemini Vision execute karein
async function uploadAndExtractOCR() {
  if (!selectedOCRFile) {
    alert("Please capture or select an image first!");
    return;
  }

  const loadingEl = document.getElementById('ocr-loading');
  const resultsEl = document.getElementById('ocr-results');
  const previewContainer = document.getElementById('image-preview-container');

  loadingEl.style.display = 'block';
  resultsEl.style.display = 'none';

  const formData = new FormData();
  formData.append('file', selectedOCRFile);
  formData.append('patient_id', patientId || 1); // Current logged-in patient ID

  try {
    const response = await fetch('https://medikiosk-backend-fqof.onrender.com/api/ocr/upload', {
      method: 'POST',
      body: formData // Content-Type header set mat karein, browser multipart/form-data boundary manage karega
    });

    const data = await response.json();
    loadingEl.style.display = 'none';

    if (!response.ok) {
      alert(data.detail || 'Could not process document.');
      return;
    }

    const ext = data.extracted_data || {};
    const dynamic = ext.dynamic_data || {};

    // UI par dynamic fields populate karein
    document.getElementById('ocr-report-type').innerText = ext.report_type || 'Medical Document';
    document.getElementById('ocr-summary').innerText = ext.clinical_summary || 'Document scanned successfully.';

    // extract medications
    if (dynamic.medications && dynamic.medications.length > 0) {
      const medList = dynamic.medications.map(m => `${m.name || ''} ${m.dosage || ''} (${m.frequency || ''})`.trim()).join(', ');
      document.getElementById('ocr-meds').innerText = medList;
    } else {
      document.getElementById('ocr-meds').innerText = 'None detected';
    }

    // extract test metrics / labs
    if (dynamic.test_metrics && dynamic.test_metrics.length > 0) {
      const metricList = dynamic.test_metrics.map(t => `${t.name}: ${t.value} ${t.unit || ''} [${t.status || 'NORMAL'}]`).join(' | ');
      document.getElementById('ocr-metrics').innerText = metricList;
    } else {
      document.getElementById('ocr-metrics').innerText = 'No quantitative lab metrics';
    }

    // extract critical / abnormal Flags
    if (dynamic.abnormal_flags && dynamic.abnormal_flags.length > 0) {
      document.getElementById('ocr-flags-container').style.display = 'block';
      document.getElementById('ocr-flags').innerText = dynamic.abnormal_flags.join(', ');
    } else {
      document.getElementById('ocr-flags-container').style.display = 'none';
    }

    resultsEl.style.display = 'block';
    lucide.createIcons();

  } catch (err) {
    console.error('OCR Upload Error:', err);
    loadingEl.style.display = 'none';
    alert('Server error while analyzing document. Make sure FastAPI is running.');
  }
}

    // ---CREATE TOKEN ---
    async function generateToken() {
      const nameInput = document.getElementById('p-name').value.trim();
      const phoneInput = document.getElementById('p-auth-phone').value.trim();
      const ageInput = parseInt(document.getElementById('p-age').value, 10) || 21;
      const genderInput = document.getElementById('p-gender').value;

      const rawTranscript = conversationHistory
        .map(turn => `${turn.role === 'user' ? 'Patient' : 'AI'}: ${turn.text}`)
        .join('\n');

      const payload = {
        full_name: nameInput || "",
        phone_number: phoneInput || "",
        gender: genderInput,
        age: ageInput,
        symptoms: latestSymptomSummary || (collectedSymptoms.length ? collectedSymptoms.join(' | ') : "Mujhe 2 ghante se seene mein dard hai"),
        medical_history: latestHistorySummary || collectedHistory.join(' | '),
        full_transcript: rawTranscript,
        department: latestDepartment || undefined,
        urgency: latestUrgency,
        priority_level: latestPriorityLevel,
        allergies: ["Penicillin", "Sulfa drugs"],
        chronic: ["Type 2 Diabetes", "Hypertension"],
        patient_id: patientId || undefined,
        consultation_type: consultationType,
        follow_up_of: followUpOfTriageId || undefined
      };

      try {
        const response = await fetch('https://medikiosk-backend-fqof.onrender.com/api/intake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (result.status === 'success') {
          document.getElementById('generated-token-num').innerText = result.token;
          document.getElementById('token-consult-type-badge').innerText =
            consultationType === 'FOLLOWUP' ? '🔁 Follow-up Consultation' : '🆕 Fresh Consultation';
          goToPatientStep(3);
        } else {
          alert('Database Error: ' + JSON.stringify(result));
        }
      } catch (err) {
        console.error('Fetch Error:', err);
        alert('Could not connect to FastAPI server at https://medikiosk-backend-fqof.onrender.com. Is it running?');
      }
    }

    // ---FETCH DOCTOR QUEUE ---
    async function fetchLiveDoctorQueue() {
      try {
        const response = await fetch('https://medikiosk-backend-fqof.onrender.com/api/doctor/queue');
        const data = await response.json();
        cachedQueue = data.queue || [];

        const queueContainer = document.getElementById('dynamic-queue-list');
        const queueBadge = document.getElementById('queue-count-badge');
        queueContainer.innerHTML = '';
        queueBadge.innerText = `${cachedQueue.length} Waiting`;

        if (cachedQueue.length === 0) {
          queueContainer.innerHTML = `<p style="font-size:0.8rem; color:var(--text-muted); text-align:center; padding:1rem;">No patients waiting in queue.</p>`;
          clearDoctorPanel();
          return;
        }

        cachedQueue.forEach((patient, idx) => {
          const item = document.createElement('div');
          item.className = `queue-item ${idx === 0 ? 'active' : ''}`;
          item.onclick = () => renderPatientDetails(idx);
          item.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>Token #OPD-${patient.token_number}</strong>
              <div style="display:flex; align-items:center; gap:0.4rem;">
                <span class="badge ${patient.speech_to_text_transcript && (patient.speech_to_text_transcript.includes('seene') || patient.speech_to_text_transcript.includes('chest') || patient.speech_to_text_transcript.includes('dard')) ? 'badge-danger' : 'badge-success'}">
                  ${patient.speech_to_text_transcript && (patient.speech_to_text_transcript.includes('seene') || patient.speech_to_text_transcript.includes('chest') || patient.speech_to_text_transcript.includes('dard')) ? '🚨 Red Flag' : 'Routine'}
                </span>
                <button class="queue-remove-btn" title="Remove from queue" onclick="event.stopPropagation(); removeFromQueue(${patient.queue_id})" style="border:none; background:transparent; color:var(--text-muted); cursor:pointer; font-size:1rem; line-height:1; padding:0.1rem 0.3rem;">✕</button>
              </div>
            </div>
            <p style="font-size: 0.8rem; margin-top: 0.2rem;">${patient.full_name} (${patient.gender})
              <span class="badge ${patient.consultation_type === 'FOLLOWUP' ? 'badge-primary' : 'badge-success'}" style="margin-left:0.3rem;">
                ${patient.consultation_type === 'FOLLOWUP' ? '🔁 Follow-up' : '🆕 Fresh'}
              </span>
            </p>
            <p style="font-size: 0.75rem; color: var(--text-muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
              ${patient.speech_to_text_transcript || 'No transcript'}
            </p>
          `;
          queueContainer.appendChild(item);
        });

        if (cachedQueue.length > 0) {
          renderPatientDetails(0);
        }
      } catch (err) {
        console.error('Queue Fetch Error:', err);
      }
    }

    function renderPatientDetails(index) {
      const p = cachedQueue[index];
      if (!p) return;
      selectedQueueId = p.queue_id;
      selectedPatientId = p.patient_id;

      document.querySelectorAll('.queue-item').forEach((el, i) => {
        el.classList.toggle('active', i === index);
      });

      document.getElementById('doc-p-name').innerText = p.full_name;
      const consultLabel = p.consultation_type === 'FOLLOWUP' ? '🔁 Follow-up Consultation' : '🆕 Fresh Consultation';
      document.getElementById('doc-p-meta').innerText = `${p.age_meta || 'Age: 21'} • Gender: ${p.gender} • Token #OPD-${p.token_number} • ${consultLabel}`;
      document.getElementById('doc-transcript').innerText = p.speech_to_text_transcript || 'None';

      let summaryHtml = '<span style="color:var(--text-muted);">None</span>';
      let currentSymptomsText = 'None reported';
      let historyText = 'None reported';

      if (p.ai_structured_summary) {
        try {
          const summaryObj = typeof p.ai_structured_summary === 'string' 
            ? JSON.parse(p.ai_structured_summary) 
            : p.ai_structured_summary;

          currentSymptomsText = summaryObj.primary_complaint || 'None reported';
          historyText = summaryObj.history_notes || 'None reported';

          summaryHtml = `
            <div style="display:flex; flex-direction:column; gap:0.4rem;">
              <div><span class="badge ${summaryObj.urgency === 'EMERGENCY' ? 'badge-danger' : 'badge-success'}">${summaryObj.urgency || 'ROUTINE'}</span></div>
              <div><strong>Department:</strong> ${summaryObj.department || 'N/A'}</div>
            </div>
          `;
        } catch (e) {
          summaryHtml = String(p.ai_structured_summary);
        }
      }

      document.getElementById('doc-current-symptoms').innerText = currentSymptomsText;
      document.getElementById('doc-reported-history').innerText = historyText;
      document.getElementById('doc-ai-summary').innerHTML = summaryHtml;

      document.getElementById('doc-p-allergies-list').innerText = (p.known_allergies || []).join(', ') || 'None recorded';
      document.getElementById('doc-p-chronic-list').innerText = (p.chronic_conditions || []).join(', ') || 'None recorded';
      document.getElementById('doc-p-alerts').innerText = `Allergies: ${(p.known_allergies || []).join(', ') || 'None'} | Chronic: ${(p.chronic_conditions || []).join(', ') || 'None'}`;

      // Naya patient select hote hi purani prescription image / extracted-file
      // data yaad na reh jaye dono ko is patient ke liye fresh fetch karo.
      latestPatientDocuments = [];
      document.getElementById('doc-extracted-file-data').innerHTML =
        '<p style="color:var(--text-muted);">Loading extracted document data…</p>';
      fetchPatientDocumentsForPanel(p.patient_id);
    }

    // Queue khatam ho jaaye (ya koi patient select na ho) toh doctor ke
    // dashboard se pichhle patient ki SAARI details hata do taaki agla
    // patient dekhne se pehle purani jaankari galti se na dikh jaaye.
    function clearDoctorPanel() {
      selectedQueueId = null;
      selectedPatientId = null;
      latestPatientDocuments = [];

      document.getElementById('doc-p-name').innerText = '—';
      document.getElementById('doc-p-meta').innerText = 'No patient selected';
      document.getElementById('doc-transcript').innerText = 'None';
      document.getElementById('doc-current-symptoms').innerText = 'None';
      document.getElementById('doc-reported-history').innerText = 'None';
      document.getElementById('doc-ai-summary').innerHTML = 'None';
      document.getElementById('doc-p-allergies-list').innerText = 'None recorded';
      document.getElementById('doc-p-chronic-list').innerText = 'None recorded';
      document.getElementById('doc-p-alerts').innerText = 'No active patient';
      document.getElementById('doc-extracted-file-data').innerHTML =
        '<p style="color:var(--text-muted);">No documents on file.</p>';

      const diagnosisEl = document.getElementById('doc-diagnosis');
      if (diagnosisEl) diagnosisEl.value = '';

      const rxTableBody = document.getElementById('rx-table')?.getElementsByTagName('tbody')[0];
      if (rxTableBody) rxTableBody.innerHTML = '';
    }

    // Selected patient ke saare uploaded documents fetch karta hai "Extracted
    // File Data" panel ko live data se bharne ke liye, aur prescription-image
    // modal ke liye latest file_url yaad rakhne ke liye.
    let latestPatientDocuments = [];

    async function fetchPatientDocumentsForPanel(patientIdForDocs) {
      try {
        const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientIdForDocs}/medical-history`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return;

        latestPatientDocuments = data.documents || [];
        const container = document.getElementById('doc-extracted-file-data');

        if (!latestPatientDocuments.length) {
          container.innerHTML = '<p style="color:var(--text-muted);">No documents on file.</p>';
          return;
        }

        // Sabse latest document ka extracted data dikhao
        const latest = latestPatientDocuments[0];
        const ext = latest.extracted_data || {};
        const dynamic = ext.dynamic_data || {};

        let rows = '';
        if (ext.blood_group) rows += `<p style="margin-bottom:0.3rem;"><strong>Blood Group:</strong> ${ext.blood_group}</p>`;
        if (dynamic.test_metrics && dynamic.test_metrics.length) {
          rows += `<p><strong>Recent Labs:</strong> ${dynamic.test_metrics.map(t => `${t.name}: ${t.value}${t.unit || ''}`).join(', ')}</p>`;
        }
        if (!rows) rows = '<p style="color:var(--text-muted);">No structured fields extracted yet.</p>';
        container.innerHTML = rows;
      } catch (err) {
        console.error('Fetch patient documents failed:', err);
      }
    }

    function openPrescriptionImageModal() {
      const imgEl = document.getElementById('prescription-modal-img');
      const captionEl = document.getElementById('prescription-modal-caption');

      if (!latestPatientDocuments.length) {
        alert('Is patient ke liye koi scanned document upload nahi hua hai.');
        return;
      }

      // Sabse latest uploaded document dikhao
      const latest = latestPatientDocuments[0];
      if (!latest.file_url) {
        alert('Document mila, lekin original image file save nahi hui thi.');
        return;
      }

      imgEl.src = latest.file_url;
      captionEl.innerText = latest.created_at
        ? `Uploaded on ${new Date(latest.created_at).toLocaleDateString()}`
        : '';

      document.getElementById('image-modal').style.display = 'flex';
    }

    // --- PAST MEDICAL HISTORY ---
    async function openPatientHistory() {
      if (!selectedPatientId) { alert('Select a patient from the queue first.'); return; }

      switchView('patient-history');
      document.getElementById('hist-loading').style.display = 'block';
      document.getElementById('hist-content').style.display = 'none';

      try {
        const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${selectedPatientId}/medical-history`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.detail || 'Could not load medical history.');
          switchView('doctor');
          return;
        }
        renderPatientHistory(data);
      } catch (err) {
        console.error('Medical history fetch failed:', err);
        alert('Could not reach the server to load medical history.');
        switchView('doctor');
      }
    }

    function renderPatientHistory(data) {
      const patient = data.patient || {};
      document.getElementById('hist-p-meta').innerText =
        `${patient.full_name || 'Unknown patient'} • ${patient.gender || '—'} • DOB: ${patient.dob || 'Not on file'} • ${patient.phone_number || ''}`;

      // classified permanent-record fields
      document.getElementById('hist-allergies').innerText = (patient.known_allergies || []).length
        ? patient.known_allergies.join(', ') : 'None recorded';
      document.getElementById('hist-chronic').innerText = (patient.chronic_conditions || []).length
        ? patient.chronic_conditions.join(', ') : 'None recorded';
      document.getElementById('hist-surgeries').innerText = (patient.past_surgeries || []).length
        ? patient.past_surgeries.join(', ') : 'None recorded';

      // Documents classify each extracted field
      // under the same headings rather than dumping raw JSON.
      const docsEl = document.getElementById('hist-documents');
      const documents = data.documents || [];
      if (!documents.length) {
        docsEl.innerHTML = 'No uploaded documents on file.';
      } else {
        docsEl.innerHTML = documents.map(doc => {
  const extracted = doc.extracted_data || {};
  const knownFieldLabels = {
    blood_group: 'Blood Group', vitals: 'Vitals', labs: 'Recent Labs',
    allergies: 'Allergies (from document)', chronic_conditions: 'Chronic Conditions (from document)',
    medications: 'Medications', diagnoses: 'Diagnoses'
  };
  let rows = '';
  Object.keys(extracted).forEach(key => {
    const label = knownFieldLabels[key] || key.replace(/_/g, ' ');
    const val = extracted[key];
    rows += `<p style="margin-bottom:0.25rem;"><strong>${label}:</strong> ${Array.isArray(val) ? val.join(', ') : val}</p>`;
  });
  const verifiedBadge = doc.is_doctor_verified
    ? '<span class="badge badge-success">✅ Doctor Verified</span>'
    : '<span class="badge badge-secondary">Not Yet Verified</span>';
  const verifyButton = doc.is_doctor_verified
    ? ''
    : `<button class="btn btn-secondary btn-sm" style="margin-top:0.5rem;" onclick="verifyDocument(${doc.id})">
         <i data-lucide="check-circle" style="width:14px;"></i> Verify this document
       </button>`;
  return `
    <div style="border:1px dashed var(--border); border-radius:var(--radius-sm); padding:0.7rem; margin-bottom:0.6rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
        <span style="font-size:0.75rem; color:var(--text-muted);">${doc.created_at ? new Date(doc.created_at).toLocaleDateString() : ''}</span>
        ${verifiedBadge}
      </div>
      ${rows || '<p style="color:var(--text-muted);">No structured fields extracted yet.</p>'}
      ${doc.doctor_notes ? `<p style="margin-top:0.4rem;"><strong>Doctor Notes:</strong> ${doc.doctor_notes}</p>` : ''}
      ${verifyButton}
    </div>
  `;
}).join('');
if (window.lucide) lucide.createIcons();
      }


      // Past consultations
      const consultEl = document.getElementById('hist-consultations');
      const consultations = data.consultations || [];
      if (!consultations.length) {
        consultEl.innerHTML = 'No past consultations on file.';
      } else {
        consultEl.innerHTML = consultations.map(c => {
          let dept = 'General Medicine', complaint = 'No summary recorded', urgency = 'ROUTINE';
          try {
            const summary = typeof c.ai_structured_summary === 'string' ? JSON.parse(c.ai_structured_summary) : c.ai_structured_summary;
            if (summary) {
              dept = summary.department || dept;
              complaint = summary.primary_complaint || complaint;
              urgency = summary.urgency || urgency;
            }
          } catch (e) { /* keep defaults */ }
          const dateStr = c.created_at ? new Date(c.created_at).toLocaleDateString() : 'Date unknown';
          return `
            <div style="border-bottom:1px solid var(--border); padding:0.6rem 0;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="font-size:0.85rem;">${dept}</strong>
                <span class="badge ${urgency === 'EMERGENCY' ? 'badge-danger' : 'badge-success'}">${urgency}</span>
              </div>
              <p style="font-size:0.8rem; margin-top:0.2rem;">${complaint}</p>
              <p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">${dateStr} • ${c.consultation_type === 'FOLLOWUP' ? 'Follow-up' : 'Fresh'}</p>
            </div>
          `;
        }).join('');
      }

      document.getElementById('hist-loading').style.display = 'none';
      document.getElementById('hist-content').style.display = 'block';
    }

    async function verifyDocument(documentId) {
  try {
    const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/documents/${documentId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_verified: true })
    });
    if (!res.ok) { alert('Could not verify document.'); return; }
    openPatientHistory(); // panel ko fresh data se refresh karo
  } catch (err) {
    console.error('Verify document failed:', err);
    alert('Server error while verifying document.');
  }
}

    function closePrescriptionImageModal() {
      document.getElementById('image-modal').style.display = 'none';
    }

    function addMedicineRow() {
      const table = document.getElementById('rx-table').getElementsByTagName('tbody')[0];
      const newRow = table.insertRow();
      newRow.innerHTML = `
        <td><input type="text" class="input-field" value="Tab Atorvastatin" style="padding:0.3rem;" /></td>
        <td><input type="text" class="input-field" value="20 mg" style="padding:0.3rem;" /></td>
        <td><input type="text" class="input-field" value="0-0-1" style="padding:0.3rem;" /></td>
        <td><input type="text" class="input-field" value="30 Days" style="padding:0.3rem;" /></td>
      `;
    }

    async function removeFromQueue(queueId) {
      if (!queueId) return;
      if (!confirm('Remove this patient from the live queue?')) return;

      try {
        const response = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/doctor/queue/${queueId}`, {
          method: 'DELETE'
        });
        const data = await response.json();

        if (!response.ok) {
          alert('Could not remove patient: ' + (data.detail || 'Unknown error'));
          return;
        }

        if (selectedQueueId === queueId) selectedQueueId = null;
        fetchLiveDoctorQueue();
      } catch (err) {
        console.error('Remove Queue Error:', err);
        alert('Server error while removing patient from queue.');
      }
    }

    function collectPrescribedMedicines() {
  const rows = document.querySelectorAll('#rx-table tbody tr');
  const medicines = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    if (inputs.length >= 4 && inputs[0].value.trim()) {
      medicines.push({
        name: inputs[0].value.trim(),
        dose: inputs[1].value.trim(),
        frequency: inputs[2].value.trim(),
        duration: inputs[3].value.trim()
      });
    }
  });
  return medicines;
}

async function completeConsultation() {
  if (!selectedQueueId) return;

  const diagnosis = document.getElementById('doc-diagnosis')?.value.trim() || null;
  const medicines = collectPrescribedMedicines();

  try {
    const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/doctor/queue/${selectedQueueId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagnosis, medicines })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.detail || 'Could not complete consultation.'); return; }

    alert('Consultation marked complete — prescription saved for the patient.');
    fetchLiveDoctorQueue();
  } catch (err) {
    console.error('Complete Consultation error:', err);
    alert('Server error while completing consultation.');
  }
}

    // --- DOCTOR REVIEWs ---
    let selectedReviewRating = 0;

    function selectReviewRating(value) {
      selectedReviewRating = value;
      document.querySelectorAll('#review-star-picker .review-star').forEach(star => {
        const starValue = parseInt(star.dataset.value, 10);
        star.innerText = starValue <= value ? '★' : '☆';
        star.style.color = starValue <= value ? '#f59e0b' : 'inherit';
      });
      const labels = ['', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
      document.getElementById('review-rating-label').innerText = `${value} star${value > 1 ? 's' : ''} — ${labels[value]}`;
    }

    async function submitDoctorReview() {
      if (!selectedReviewRating) {
        alert('Please tap a star to rate your visit before submitting.');
        return;
      }
      const comment = document.getElementById('review-comment').value.trim();

      try {
        const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doctor_id: 1,
            patient_id: patientId || null,
            rating: selectedReviewRating,
            comment: comment || null
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.detail || 'Could not submit review.'); return; }

        alert('Thank you! Your review has been recorded.');
        selectedReviewRating = 0;
        document.querySelectorAll('#review-star-picker .review-star').forEach(star => { star.innerText = '☆'; star.style.color = 'inherit'; });
        document.getElementById('review-rating-label').innerText = 'Tap a star to rate.';
        document.getElementById('review-comment').value = '';
        switchView('landing');
      } catch (err) {
        console.error('Review submission failed:', err);
        alert('Could not reach the server to submit your review.');
      }
    }
    // --- NEW LOGIN CHECK ---
    async function checkUserExistence() {
      const mobile = document.getElementById('login-identifier-input').value.trim();
      const dob = document.getElementById('login-dob-input').value;

      if (!mobile || !dob) {
        alert("Please enter both your identifier and Date of Birth.");
        return;
      }

      if (loginIdentifierType === 'MOBILE') {
        try {
          const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/check?mobile=${mobile}`);
          const data = await res.json();
          
          document.getElementById('login-check-btn').style.display = 'none';
          document.getElementById('dynamic-auth-options').style.display = 'block';

          if (data.exists) {
            document.getElementById('auth-method-toggle-group').style.display = 'block';
            document.getElementById('new-user-name-group').style.display = 'none';
            selectLoginMethod('PASSWORD');
          } else {
            document.getElementById('auth-method-toggle-group').style.display = 'none';
            document.getElementById('new-user-name-group').style.display = 'block';
            selectLoginMethod('OTP');
          }
          lucide.createIcons();
        } catch (err) {
          console.error("Failed to check user existence", err);
          alert("Could not reach the server.");
        }
      } else {
        document.getElementById('login-check-btn').style.display = 'none';
        document.getElementById('dynamic-auth-options').style.display = 'block';
        selectLoginMethod('OTP');
        lucide.createIcons();
      }
    }
    
  async function loadMyPrescriptions() {
  const container = document.getElementById('my-prescriptions-list');
  if (!patientId) {
    container.innerHTML = '<p style="color:var(--text-muted);">Please log in first.</p>';
    return;
  }
  container.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';

  try {
    const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientId}/prescriptions`);
    const data = await res.json().catch(() => ({}));
    const prescriptions = data.prescriptions || [];

    if (!prescriptions.length) {
      container.innerHTML = '<p style="color:var(--text-muted);">No prescriptions on file yet.</p>';
      return;
    }

    container.innerHTML = prescriptions.map(p => {
      const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString() : 'Date unknown';
      const medsHtml = (p.medicines || []).length
        ? `<table class="rx-table"><thead><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Duration</th></tr></thead>
             <tbody>${p.medicines.map(m => `<tr><td>${m.name}</td><td>${m.dose}</td><td>${m.frequency}</td><td>${m.duration}</td></tr>`).join('')}</tbody>
           </table>`
        : '<p style="color:var(--text-muted);">No medicines recorded.</p>';

      return `
        <div class="card" style="margin-bottom:1rem;">
          <p style="font-size:0.8rem; color:var(--text-muted);">${dateStr}</p>
          <p style="font-weight:600; margin:0.3rem 0;">${p.diagnosis || 'No diagnosis recorded'}</p>
          ${medsHtml}
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Load prescriptions failed:', err);
    container.innerHTML = '<p style="color:var(--text-muted);">Could not load prescriptions.</p>';
  }
} 

// Patient apne saare uploaded/lab-pushed documents (image + OCR extracted data)
// khud dekh sake bilkul doctor wale "Past Medical History" jaisa hi view,
// bas isi patient ke record tak limited (usi /medical-history route se aata
// hai jo doctor bhi use karta hai is route me file_url pehle se hai).
async function loadMyDocuments() {
  const container = document.getElementById('my-documents-list');
  if (!patientId) {
    container.innerHTML = '<p style="color:var(--text-muted);">Please log in first.</p>';
    return;
  }
  container.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';

  try {
    const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/patient/${patientId}/medical-history`);
    const data = await res.json().catch(() => ({}));
    const documents = data.documents || [];

    if (!documents.length) {
      container.innerHTML = '<p style="color:var(--text-muted);">No documents uploaded yet.</p>';
      return;
    }

    container.innerHTML = documents.map(doc => {
      const dateStr = doc.created_at ? new Date(doc.created_at).toLocaleDateString() : 'Date unknown';
      const sourceLabel = doc.source === 'LAB' ? '🧪 Lab Report' : '📷 Self-uploaded';
      const verifiedBadge = doc.is_doctor_verified
        ? '<span class="badge badge-success">✅ Doctor Verified</span>'
        : '<span class="badge badge-secondary">Pending Doctor Verification</span>';

      const extracted = doc.extracted_data || {};
      let rows = '';
      if (extracted.clinical_summary) {
        rows += `<p style="margin-bottom:0.3rem;">${extracted.clinical_summary}</p>`;
      }
      if (extracted.blood_group) {
        rows += `<p style="margin-bottom:0.3rem;"><strong>Blood Group:</strong> ${extracted.blood_group}</p>`;
      }

      const viewImageBtn = doc.file_url
        ? `<button class="btn btn-secondary btn-sm" style="margin-top:0.5rem;"
             onclick="window.open('${doc.file_url}', '_blank')">
             <i data-lucide="image" style="width:14px;"></i> View Original Document
           </button>`
        : '';

      return `
        <div class="card" style="margin-bottom:1rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
            <span style="font-size:0.8rem; color:var(--text-muted);">${dateStr} • ${sourceLabel}</span>
            ${verifiedBadge}
          </div>
          ${rows || '<p style="color:var(--text-muted);">No summary extracted.</p>'}
          ${viewImageBtn}
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Load documents failed:', err);
    container.innerHTML = '<p style="color:var(--text-muted);">Could not load documents.</p>';
  }
}

let currentLabId = null;
let foundLabPatientId = null;

async function labLogin() {
  const staffId = document.getElementById('lab-id-input').value.trim();
  const pwd = document.getElementById('lab-pwd-input').value;
  if (!staffId || !pwd) { alert('Please enter Lab Staff ID and password.'); return; }

  try {
    const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/lab/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, password: pwd })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.detail || 'Invalid Lab Staff ID or password.'); return; }

    currentLabId = data.lab_id;
    document.getElementById('lab-header-name').innerText = data.lab_name;
    switchView('lab');
  } catch (err) {
    console.error('Lab login failed:', err);
    alert('Could not reach the server to sign in.');
  }
}

async function searchPatientForLab() {
  const mobile = document.getElementById('lab-search-mobile').value.trim();
  const abha = document.getElementById('lab-search-abha').value.trim();
  const resultEl = document.getElementById('lab-search-result');

  if (!mobile && !abha) { alert('Enter mobile number or ABHA ID.'); return; }

  try {
    const params = mobile ? `mobile=${mobile}` : `abha=${abha}`;
    const res = await fetch(`https://medikiosk-backend-fqof.onrender.com/api/lab/patient-lookup?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      resultEl.innerHTML = `<p style="color:var(--danger);">${data.detail || 'Patient not found.'}</p>`;
      foundLabPatientId = null;
      return;
    }

    foundLabPatientId = data.patient_id;
    resultEl.innerHTML = `
      <p style="color:var(--success); font-weight:600;">✅ Found: ${data.full_name}</p>
      <p style="font-size:0.8rem; color:var(--text-muted);">${data.phone_number} • ABHA: ${data.abha_number || 'Not linked'}</p>
    `;
    document.getElementById('lab-upload-section').style.display = 'block';
  } catch (err) {
    console.error('Patient lookup failed:', err);
    resultEl.innerHTML = '<p style="color:var(--danger);">Server error while searching.</p>';
  }
}

async function uploadLabReport() {
  const fileInput = document.getElementById('lab-report-file');
  if (!foundLabPatientId) { alert('Search and select a patient first.'); return; }
  if (!fileInput.files[0]) { alert('Choose a report file first.'); return; }

  const formData = new FormData();
  formData.append('patient_id', foundLabPatientId);
  formData.append('file', fileInput.files[0]);

  const statusEl = document.getElementById('lab-upload-status');
  statusEl.innerText = 'Uploading and extracting report…';

  try {
    const res = await fetch('https://medikiosk-backend-fqof.onrender.com/api/lab/upload-report', {
      method: 'POST',
      body: formData
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.innerText = data.detail || 'Upload failed.';
      return;
    }
    statusEl.innerText = '✅ Report pushed to patient\'s medical history successfully.';
    fileInput.value = '';
  } catch (err) {
    console.error('Lab report upload failed:', err);
    statusEl.innerText = 'Server error during upload.';
  }
}