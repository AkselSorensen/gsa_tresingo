document.addEventListener("DOMContentLoaded", () => {
  const heroLanguageButton = document.querySelector(".hero-lang");

  if (!heroLanguageButton) return;

  heroLanguageButton.addEventListener("click", () => {
    heroLanguageButton.textContent = heroLanguageButton.textContent === "EN" ? "FR" : "EN";
  });
});