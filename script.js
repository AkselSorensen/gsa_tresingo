document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.querySelector(".search input");
  const navLinks = document.querySelectorAll(".nav a");
  const buttons = document.querySelectorAll("button");

  if (searchInput) {
    searchInput.addEventListener("focus", () => {
      document.body.classList.add("search-active");
    });

    searchInput.addEventListener("blur", () => {
      document.body.classList.remove("search-active");
    });
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
  });

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.add("pressed");
      window.setTimeout(() => {
        button.classList.remove("pressed");
      }, 140);
    });
  });
});
