// Presentation only: never reads credentials, submits a form, or makes a network request.
const examples = {
  line: { source: "LINE", question: "您好，想了解這款商品。", answer: "您好，很高興為您介紹。\n想先了解規格，還是使用方式呢？" },
  facebook: { source: "Messenger", question: "第一次來，想請你們推薦。", answer: "很高興認識您。\n可以先告訴我您的需求嗎？" },
  instagram: { source: "Instagram", question: "剛看到你們的貼文，想了解更多！", answer: "謝謝您的關注！\n想了解貼文中的哪一款商品呢？" },
};
const controls = document.querySelectorAll("[data-demo-channel]");
for (const button of controls) button.addEventListener("click", () => {
  const example = examples[button.dataset.demoChannel];
  if (!example) return;
  for (const other of controls) other.setAttribute("aria-pressed", String(other === button));
  document.getElementById("auth-demo-source").textContent = `透過 ${example.source} 傳來訊息`;
  document.getElementById("auth-demo-question").textContent = example.question;
  document.getElementById("auth-demo-answer").textContent = example.answer;
});

const panel = document.getElementById("signed-out"), tabs = document.querySelector(".email-tabs");
if (panel && tabs) {
  const updateHeading = () => {
    if (panel.hidden || document.body.classList.contains("authenticated")) return;
    const login = document.getElementById("mode-login").getAttribute("aria-pressed") === "true";
    const register = document.getElementById("mode-register").getAttribute("aria-pressed") === "true";
    const [heading, intro] = login ? ["歡迎回來", "登入你的工作空間。"] : register ? ["從這裡開始", "建立帳號，讓每一次對話更有連結。"] : ["重設密碼", "輸入電子郵件，我們會寄送重設指引。"];
    document.getElementById("title").textContent = heading;
    panel.querySelector(".intro").textContent = intro;
  };
  const observer = new MutationObserver(updateHeading);
  observer.observe(tabs, { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  updateHeading();
}
