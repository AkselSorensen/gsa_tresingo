document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".trending-carousel-strip").forEach((carousel) => {
    carousel.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        carousel.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false });
  });
});